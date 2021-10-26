import _ from 'lodash';
import aws from 'aws-sdk';
import logger from '../../logger';
import config from '../../../config';
import { IProjectDoc } from '../../../models/project.model';
import { getTaskEnvironment, PreviewContainerLogs, PreviewContainerService, shouldKeepLogMessage } from './common-container-service';
import { uniqueAlphanumericName } from '../../project-services/project-utils';

const healthValues = {
    HEALTHY: true,
    UNHEALTHY: false,
    UNKNOWN: null
};

const removeTaskStopReason = '[stackbit] API::removeTask';

const containerInstanceExternalHostnames: Record<string, string> = {};

type SharedTaskHandle = string;

function validateTaskHandle(taskHandle: any): SharedTaskHandle {
    if (typeof taskHandle !== 'string') {
        throw new Error(`invalid shared task handle ${JSON.stringify(taskHandle)}`);
    }
    return taskHandle;
}

export const sharedContainerService: PreviewContainerService = {
    taskHandleKey: 'taskArn',
    newTaskHandleKey: 'newTaskArn',
    prevTaskHandleKey: 'prevTaskArn',
    createTask,
    removeTask,
    getTask,
    getContainerUrl,
    getExternalAddress,
    getLogs
};

async function createTask(project: IProjectDoc, environmentName?: string | null): Promise<SharedTaskHandle> {
    const env: Record<string, string | undefined> = {
        ...getTaskEnvironment(project, environmentName),
        CONFIG_ENV: config.container.env
    };

    const params = {
        ...config.container.shared.taskDetails,
        tags: [
            {
                key: 'projectId',
                value: project.id
            },
            {
                key: 'userId',
                value: project.ownerId!.toString()
            }
        ]
    };

    const taskDefinitionForProject = getTaskDefinitionForProject(project);
    if (taskDefinitionForProject) {
        _.set(params, 'taskDefinition', taskDefinitionForProject);
    }

    _.set(params, 'overrides.containerOverrides[0].name', config.container.shared.taskDetails.cluster);
    _.set(params, 'overrides.containerOverrides[0].environment', Object.keys(env).map(name => {
        const val = env[name];
        return {
            name,
            value: _.isObject(val) ? JSON.stringify(val) : val
        };
    }));

    const ecs = new aws.ECS({
        region: 'us-east-1'
    });

    const data = await ecs.runTask(params).promise();
    const taskArn = data.tasks?.[0]?.taskArn;
    if (!taskArn) {
        throw data;
    }
    return taskArn;
}

function getTaskDefinitionForProject(project: IProjectDoc) {
    const isGenericContainer = project.settings.isGenericContainer; // Flag used for non-theme projects.
    const theme = project.wizard?.theme?.id;
    const ssg = project.wizard?.ssg?.id;
    const prepackagedTaskDefinition = ssg && (config.container.shared.prepackagedTaskDefinitions as Record<string, string>)[ssg]; // TODO: move this cast to build-config in single-config v2

    // use prepackaged images if they exist and we don't explicitly require a generic image
    // Only catalog themes with gatsby or nextjs
    if (prepackagedTaskDefinition && !isGenericContainer && theme && theme !== 'custom') {
        return prepackagedTaskDefinition;
    }

    // all imported OR all custom theme OR all hugo/jekyll
    return config.container.shared.genericTaskDefinition;
}

async function removeTask(taskHandle: unknown): Promise<void> {
    const taskArn = validateTaskHandle(taskHandle);
    const ecs = new aws.ECS({
        region: 'us-east-1'
    });
    const params = {
        cluster: config.container.shared.taskDetails.cluster,
        task: taskArn,
        reason: removeTaskStopReason
    };
    try {
        const data = await ecs.stopTask(params).promise();
        if (!data.task) {
            throw data;
        }
    } catch (err) {
        logger.debug('[shared-container-service] error removing task', { taskArn: taskArn, err });
        // don't throw error if task is MISSING
        if (_.get(err, 'code') !== 'InvalidParameterException') {
            throw err;
        }
    }
}
async function getTask(taskHandle: unknown): Promise<{
    containerInstanceArn: string;
    isRunning: boolean;
    healthy: boolean;
    hostPort?: number;
    explicitlyStopped: boolean;
}> {
    const taskArn = validateTaskHandle(taskHandle);
    const ecs = new aws.ECS({
        region: 'us-east-1',
    });
    const data = await ecs
        .describeTasks({
            tasks: [taskArn],
            cluster: config.container.shared.taskDetails.cluster,
        })
        .promise();
    const taskInfo = data.tasks?.[0]?.containers?.[0];
    if (!taskInfo) {
        throw data;
    }
    return {
        containerInstanceArn: _.get(data, 'tasks[0].containerInstanceArn'),
        isRunning: taskInfo.lastStatus === 'RUNNING',
        healthy: _.get(healthValues, taskInfo.healthStatus!),
        hostPort: taskInfo.networkBindings?.[0]?.hostPort,
        explicitlyStopped:
            taskInfo.lastStatus === 'STOPPED' &&
            (taskInfo as any).stoppedReason === removeTaskStopReason,
    };
}

async function getContainerUrl(project: IProjectDoc, _taskHandle: unknown): Promise<string> {
    const projectName = uniqueAlphanumericName(project, project.name!);
    const envSubdomain = config.env === 'prod' ? '' : '.staging';
    return `https://preview--${projectName}${envSubdomain}.stackbit.dev`;
}

async function getExternalAddress(taskHandle: unknown): Promise<{ hostname?: string; port?: number }> {
    const taskArn = validateTaskHandle(taskHandle);
    const taskInfo = await getTask(taskArn);
    const cachedHostname = containerInstanceExternalHostnames[taskInfo.containerInstanceArn];
    if (cachedHostname) {
        return {
            hostname: cachedHostname,
            port: taskInfo.hostPort
        };
    }
    const ecs = new aws.ECS({
        region: 'us-east-1'
    });
    const containerInstances = await ecs.describeContainerInstances({
        containerInstances: [taskInfo.containerInstanceArn],
        cluster: config.container.shared.taskDetails.cluster
    }).promise();
    const containerInstance = containerInstances.containerInstances?.[0];
    if (!containerInstance) {
        throw containerInstances;
    }
    const ec2 = new aws.EC2({
        region: 'us-east-1'
    });
    const data = await ec2.describeInstances({
        InstanceIds: [containerInstance.ec2InstanceId!]
    }).promise();
    const instanceInfo = data.Reservations?.[0]?.Instances?.[0];
    if (!instanceInfo) {
        throw data;
    }
    const hostname = instanceInfo.NetworkInterfaces?.[0]?.Association?.PublicDnsName ?? instanceInfo.NetworkInterfaces?.[0]?.Association?.PublicIp;
    if (hostname) {
        containerInstanceExternalHostnames[taskInfo.containerInstanceArn] = hostname;
    }
    return {
        hostname,
        port: taskInfo.hostPort
    };
}

function cleanupLogMessage(message: string) {
    let result = message;
    ['debug: ', 'info: ', 'warn: '].forEach(s => {
        if (result.startsWith(s)) {
            result = result.slice(s.length);
        }
    });
    // remove message parameters
    result = result.replace(/ {.*?}$/, '');
    // remove local path
    result = result
        .replace('/home/appuser/app/', '')
        .replace('/home/appuser/', '');
    return result;
}

async function getLogs(taskHandle: unknown, nextToken?: string, startDate?: Date, retryCount = 0): Promise<PreviewContainerLogs> {
    const taskArn = validateTaskHandle(taskHandle);
    const taskId = taskArn.split('/').slice(-1)[0];
    const streamName = config.container.shared.logs.streamNamePrefix + taskId;

    const cloudwatchlogs = new aws.CloudWatchLogs({
        region: 'us-east-1'
    });
    const params: aws.CloudWatchLogs.FilterLogEventsRequest = {
        logGroupName: config.container.shared.logs.groupName,
        logStreamNames: [streamName],
        filterPattern: '{ $.tag = "user-log" }',
        startTime: startDate?.getTime(),
        nextToken
    };
    try {
        const data = await cloudwatchlogs.filterLogEvents(params).promise();
        const events = (data.events ?? []).map(event => {
            if (!event.message) {
                return;
            }
            const message = cleanupLogMessage(event.message);
            if (!shouldKeepLogMessage(message, event.message)) {
                return;
            }
            return {
                timestamp: event.timestamp,
                message
            };
        }).filter((x): x is NonNullable<typeof x> => !!x);
        const resultNextToken = data.nextToken || nextToken;
        return {
            events,
            nextToken: resultNextToken
        };
    } catch (err) {
        if (['ThrottlingException', 'RequestLimitExceeded'].includes((err as any)?.code ?? '') && retryCount < 3) {
            logger.debug('[shared-container-service] retrying', { taskArn: taskArn, retryCount, errCode: (err as any)?.code });
            return new Promise((resolve) => {
                // retry with backoff
                setTimeout(() => {
                    resolve(getLogs(taskArn, nextToken, startDate, retryCount + 1));
                }, 2000 + (retryCount + 1) * 1000);
            });
        }
        throw err;
    }
}
