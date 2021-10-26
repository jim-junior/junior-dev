import winston from 'winston';
import config from '../../../config';
import { IProjectDoc } from '../../../models/project.model';
import { DeleteContainerDelegate } from '../container-orchestration-service';

export interface PreviewContainerEvent {
    timestamp?: number;
    message: string;
}

export interface PreviewContainerLogs {
    events: PreviewContainerEvent[];
    nextToken?: string;
    backToken?: string;
}

export interface PreviewContainerService {
    taskHandleKey: string;
    newTaskHandleKey: string;
    prevTaskHandleKey: string;
    createTask(
        project: IProjectDoc,
        environmentName: string | null | undefined,
        deleteContainer: DeleteContainerDelegate,
        buildLogger?: winston.Logger
    ): Promise<unknown>;
    removeTask(task: unknown): Promise<void>;
    getTask(task: unknown): Promise<{
        isRunning: boolean;
        healthy: boolean;
        explicitlyStopped: boolean;
    }>;
    getContainerUrl(project: IProjectDoc, task: unknown): string | Promise<string>;
    getExternalAddress?(task: unknown): Promise<{ hostname?: string; port?: number }>;
    getLogs(task: unknown, nextToken?: string, startDate?: Date): Promise<PreviewContainerLogs>;
    initializeContainerEnvironment?(): Promise<void>;
}

export function getTaskEnvironment(project: IProjectDoc, environmentName?: string | null): Record<string, string | undefined> {
    const apiKey = project.APIKeys!.find(key => key.name === 'container-key')?.key;
    return {
        STACKBIT_API_SECRET: apiKey,
        CONFIG_URL: `${config.server.webhookHostname}/project/${project.id}/config/${environmentName || ''}?key=${apiKey}`,
        WEBHOOK_URL: `${config.server.webhookHostname}/project/${project.id}/webhook/container/${environmentName || ''}`,
        CONTAINER_NAME: project.getDeploymentData('container.name', environmentName, project.name),
        STACKBIT_PROJECT_ID: project.id
    };
}

export function shouldKeepLogMessage(message: string, originalMessage = message) {
    return (message.startsWith('[gatsby]') || originalMessage.includes('"tag":"user-log"')) &&
            !message.includes('[preview plugin]');
}
