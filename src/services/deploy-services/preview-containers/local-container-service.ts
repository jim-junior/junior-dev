import axios from 'axios';
import { spawn } from 'child_process';
import findFreePorts from 'find-free-ports';
import { createReadStream } from 'fs';
import { createServer } from 'net';
import { createInterface } from 'readline';
import path from 'path';
import winston from 'winston';
import config from '../../../config';
import Project, { IProjectDoc } from '../../../models/project.model';
import logger from '../../logger';
import { getTaskEnvironment, PreviewContainerLogs, PreviewContainerService, shouldKeepLogMessage } from './common-container-service';
import { DeleteContainerDelegate } from '../container-orchestration-service';

const MAX_EVENTS_IN_LOGS_PAGE = 1000;

interface LocalTaskHandle {
    projectId: string;
    pid?: number;
    port?: number;
}

function validateTaskHandle(taskHandle: any): LocalTaskHandle {
    if (
        !taskHandle ||
        typeof taskHandle !== 'object' ||
        typeof taskHandle.projectId !== 'string' ||
        (typeof taskHandle.pid !== 'number' && typeof taskHandle.pid !== 'undefined') ||
        (typeof taskHandle.port !== 'number' && typeof taskHandle.port !== 'undefined')
    ) {
        throw new Error(`invalid local task handle ${JSON.stringify(taskHandle)}`);
    }
    const validTaskHandle: LocalTaskHandle = { projectId: taskHandle.projectId };
    if (typeof taskHandle.pid === 'number') {
        validTaskHandle.pid = taskHandle.pid;
    }
    if (typeof taskHandle.port === 'number') {
        validTaskHandle.port = taskHandle.port;
    }
    return validTaskHandle;
}

export const localContainerService: PreviewContainerService = {
    taskHandleKey: 'localTask',
    newTaskHandleKey: 'newLocalTask',
    prevTaskHandleKey: 'prevLocalTask',
    createTask,
    removeTask,
    getTask,
    getContainerUrl,
    getLogs,
    initializeContainerEnvironment
};

function logFileFromPort(port: number) {
    return `/tmp/stackbit-container-local-${port}.log`;
}

async function isDebuggerEnabled(): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', function (err) {
            if ((err as any).code === 'EADDRINUSE') {
                resolve(true);
            } else {
                reject(err);
            }
        });
        server.listen(process.debugPort, function (this: typeof server) {
            this.close();
            resolve(false);
        });
    });
}

const containerStartScript = (logFile: string, debuggerEnabled: boolean) => `
(
  [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh;
  npm ${debuggerEnabled ? 'run start:debug' : 'start'}
) 2>&1 | while read line; do echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") $line"; done >${logFile}
`;

async function createTask(
    project: IProjectDoc,
    environmentName: string | null | undefined,
    deleteContainer: DeleteContainerDelegate,
    buildLogger?: winston.Logger
): Promise<LocalTaskHandle> {
    await deleteAllOtherLocalContainers(project, deleteContainer, buildLogger);
    const [port] = await findFreePorts(1);
    if (!port) {
        logger.debug('[local-container-service] error starting task, no free port found', { projectId: project.id });
        throw new Error('no free port found');
    }
    const env = getTaskEnvironment(project, environmentName);
    const logFile = logFileFromPort(port);

    const task = spawn('bash', ['-c', containerStartScript(logFile, await isDebuggerEnabled())], {
        cwd: path.join(process.cwd(), '../stackbit-container'),
        env: {
            ...env,
            CONFIG_ENV: config.env,
            PORT: port.toString(),
            // NPM token set manually to pass nvm's sanity check.
            NPM_TOKEN: process.env.NPM_TOKEN,
            // SSH auth socket to connect to the SSH agent. Container doesn't install
            // the private key in local mode on purpose.
            SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
            // We check out projects to separate folders, since we aren't in a single-use container.
            CONTAINER_APP_PATH: `apps/${project.getDeploymentData('container.name', environmentName, project.name)}`,
            ANNOTATION_BASED: '1'
        },
        detached: true
    });
    const taskHandle = {
        projectId: project.id!,
        port,
        pid: task.pid
    };
    streamLocalContainerLogsToStdout(taskHandle);
    return taskHandle;
}

async function removeTask(taskHandle: unknown): Promise<void> {
    const task = validateTaskHandle(taskHandle);
    if (task.pid) {
        try {
            // Negative PID means to kill the entire process group.
            process.kill(0 - task.pid, 'SIGTERM');
        } catch (err) {
            logger.debug('[local-container-service] error stopping task', { ...task, err });
        }
    }
}

function pidExists(pid: number) {
    try {
        // From Node.js docs: As a special case, a signal of 0 can be used to test for the existence of a process.
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return false;
    }
}

async function portHealthy(port: number) {
    try {
        const { data } = await axios.get(`http://0.0.0.0:${port}/_health`);
        return data.status === 'ok';
    } catch (err) {
        logger.debug('[local-container-service] error checking task health', { port, err });
        return false;
    }
}

async function getTask(taskHandle: unknown) {
    const task = validateTaskHandle(taskHandle);
    if (!task.pid || !task.port) {
        return {
            isRunning: false,
            healthy: false,
            explicitlyStopped: true
        };
    }
    const isRunning = pidExists(task.pid);
    const healthy = isRunning && (await portHealthy(task.port));
    return {
        isRunning,
        healthy,
        explicitlyStopped: false
    };
}

async function getContainerUrl(_project: IProjectDoc, taskHandle: unknown) {
    const task = validateTaskHandle(taskHandle);
    return `http://0.0.0.0:${task.port}`;
}

async function getLogs(taskHandle: unknown, nextToken?: string): Promise<PreviewContainerLogs> {
    const task = validateTaskHandle(taskHandle);
    if (!task.port) {
        return {
            events: [],
            backToken: nextToken
        };
    }
    const logFile = logFileFromPort(task.port!);
    const logStream = createReadStream(logFile);
    const rl = createInterface({
        input: logStream,
        crlfDelay: Infinity
    });
    const numericNextToken = parseInt(nextToken ?? '') || 0;
    let linesSkipped = 0;
    const events: PreviewContainerLogs['events'] = [];
    let nextFound = false;
    for await (const line of rl) {
        if (linesSkipped < numericNextToken) {
            linesSkipped += 1;
            continue;
        }
        if (events.length < MAX_EVENTS_IN_LOGS_PAGE) {
            const [date, time, ...rest] = line.split(' ');
            const message = rest.join(' ');
            if (shouldKeepLogMessage(message)) {
                events.push({
                    timestamp: new Date(`${date} ${time}`).getTime(),
                    message
                });
            }
        } else {
            nextFound = true;
            logStream.destroy();
            break;
        }
    }
    return {
        events,
        nextToken: nextFound ? (numericNextToken + events.length).toString() : undefined,
        backToken: nextToken
    };
}

const streamedFiles: string[] = [];

function streamLocalContainerLogsToStdout(task: LocalTaskHandle): void {
    if (!config.features.outputLocalContainerLogs) {
        return;
    }
    if (!task.port) {
        return;
    }
    const logFile = logFileFromPort(task.port!);
    if (streamedFiles.includes(logFile)) {
        return;
    }
    streamedFiles.push(logFile);
    const tail = spawn('tail', ['-n0', '-f', logFile]);
    tail.stdout.setEncoding('utf8');
    tail.stdout.on('data', (data) => {
        // Dim yellow foreground
        // https://stackoverflow.com/a/41407246
        console.log(`\x1b[0m\x1b[2m\x1b[33m${data}\x1b[0m`);
    });
}

async function outputAllLocalContainersOutputs() {
    if (!config.features.outputLocalContainerLogs) {
        return;
    }
    const projects = await Project.findProjectsWithRunningLocalContainer();
    for (const project of projects) {
        const taskHandle =
            project.getDeploymentData<LocalTaskHandle>(`container.${localContainerService.taskHandleKey}`) ??
            project.getDeploymentData<LocalTaskHandle>(`container.${localContainerService.newTaskHandleKey}`);
        if (taskHandle) {
            streamLocalContainerLogsToStdout(taskHandle);
        }
    }
}

async function initializeContainerEnvironment(): Promise<void> {
    await outputAllLocalContainersOutputs();
}

// This is a trick, for now, to conserve developers' RAM.
// If this is ever removed, note that container always uses the same ports for Next.js and IM. To run multiple
// local containers, unique port numbers have to be selected for those.
async function deleteAllOtherLocalContainers(project: IProjectDoc, deleteContainer: DeleteContainerDelegate, buildLogger?: winston.Logger) {
    const projects = await Project.findProjectsWithRunningLocalContainer();
    for (const proj of projects) {
        if (proj.id !== project.id) {
            deleteContainer(proj, undefined, undefined, buildLogger);
        }
    }
}
