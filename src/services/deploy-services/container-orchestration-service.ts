import _ from 'lodash';
import winston from 'winston';
import config from '../../config';
import analytics from '../analytics/analytics';
import Project, { IProjectDoc } from '../../models/project.model';
import { IUserDoc } from '../../models/user.model';
import { PromiseType } from '../../type-utils';
import logger from '../logger';
import { delayPromise } from '../utils/code.utils';
import { getProjectEnvironments } from '../project-services/project-utils';
import containerService from './container-service';
import { sendSlackProjectMessage } from '../analytics/slack-notifier';
import { forEachPreviewContainerService, getProjectPreviewContainerService, PreviewContainerService } from './preview-containers';
import routerService from './container-router-client';

const MAX_UPGRADE_TIME = 15 * 60 * 1000;

export const BuildStates = {
    provisioningCms: 'provisioningCms',
    initializing: 'initializing',
    initialized: 'initialized',
    appReady: 'appReady',
} as const;

export const ContainerStates = {
    hibernating: 'hibernating',
    starting: 'starting',
    running: 'running',
    restarting: 'restarting',
    failed: 'failed',
    unknown: 'unknown',
} as const;

function getRoutedUrls(project: IProjectDoc, environmentName?: string | null) {
    return [project.getDeploymentData<string>('container.url', environmentName)].filter((x): x is NonNullable<typeof x> => !!x);
}

async function registerUrl<TaskHandle>(
    project: IProjectDoc,
    service: PreviewContainerService,
    taskHandle: TaskHandle,
    environmentName?: string | null
) {
    if (!service.getExternalAddress) {
        return;
    }
    let address = await service.getExternalAddress(taskHandle);
    if (!address.port) {
        logger.warn('[shared-container] error retrieving port. trying again...', {projectId: project.id, address});
        await delayPromise(2000);
    }
    address = await service.getExternalAddress(taskHandle);
    if (!address.port) {
        logger.error('[shared-container] error retrieving port', {projectId: project.id, address});
    }
    const url = `http://${address.hostname}:${address.port}`;
    logger.debug('[shared-container] registering container: ' + url, {projectId: project.id, taskHandle});
    await Promise.all(getRoutedUrls(project, environmentName).map(host => routerService.register(host, url)));
}

async function handleUnhealthy(project: IProjectDoc, user: IUserDoc | undefined, environmentName?: string | null, isFatal?: boolean) {
    const newTaskCreatedAt = project.getDeploymentData<Date>('container.newTaskCreatedAt', environmentName);
    const fatalWhenStarting = isFatal && project.getDeploymentData<string>('container.status', environmentName) === ContainerStates.starting;

    const service = getProjectPreviewContainerService(project);
    const taskHandle = project.getDeploymentData(`container.${service.taskHandleKey}`, environmentName);
    let task: PromiseType<ReturnType<typeof service.getTask>> | undefined;
    try {
        if (taskHandle) {
            task = await service.getTask(taskHandle);
        }
    } catch (err) {
        logger.debug('[shared-container] error retrieving current task', { projectId: project.id, err, taskHandle });
    }

    // if we're already upgrading, handle that and return
    // or if we got a fatal error on a new container
    if (fatalWhenStarting || newTaskCreatedAt) {
        const newTaskHandle = project.getDeploymentData(`container.${service.newTaskHandleKey}`, environmentName);
        const timeSinceUpgradeStart = new Date().getTime() - project.getDeploymentData<Date>('container.newTaskCreatedAt', environmentName, new Date()).getTime();
        let upgradeFailed = isFatal || timeSinceUpgradeStart > MAX_UPGRADE_TIME;
        if (newTaskHandle && !upgradeFailed) {
            const task = await service.getTask(newTaskHandle);
            upgradeFailed = !task.isRunning && !task.explicitlyStopped; // task crashed
        }
        const oldTaskIsHealthy = task?.healthy ?? false;
        const shouldHibernate = upgradeFailed && !oldTaskIsHealthy; // hibernate if upgrade failed and we can't fallback to existing task
        if (shouldHibernate) {
            logger.error('[shared-container] container unhealthy. shutting down...', {
                projectId: project.id,
                timeSinceUpgradeStart,
                newTaskHandle,
                fatalWhenStarting,
                newTaskCreatedAt,
                taskArn: project.getDeploymentData<string>('container.taskArn', environmentName) // only works with ECS containers
            });
            await hibernateContainer(project, user, environmentName);
            const updatedProject = await Project.updateDeploymentData(project._id!, 'container', {
                status: ContainerStates.failed
            }, environmentName);
            if (updatedProject?.wizard?.theme?.id === 'custom') {
                sendSlackProjectMessage(config.slack.leadsCustomTheme, 'Container Failed', updatedProject, user);
            }
            return;
        } else if (upgradeFailed) {
            logger.warn('[shared-container] upgrade failed, stopping new task', { projectId: project.id });
            if (newTaskHandle) {
                await service.removeTask(newTaskHandle);
            }
            await Project.updateDeploymentData(project._id!, 'container', {
                [service.newTaskHandleKey]: null,
                newTaskCreatedAt: null,
                status: ContainerStates.running
            }, environmentName);
            analytics.track('SharedContainer Project Upgrade Failed', {
                projectId: project.id,
                userId: user?.id
            }, user);
            return;
        } else {
            logger.warn('[shared-container] container unhealthy, already upgrading', {projectId: project.id});
            return;
        }
    }

    analytics.track('SharedContainer Project Preview Unhealthy', {
        projectId: project.id,
        userId: user?.id,
        isFatal
    }, user);

    if (!taskHandle || !task) {
        return;
    }

    const taskCrashed = !task.isRunning && !task.explicitlyStopped;

    // explicitly verify that AWS task turned unhealthy
    if (isFatal || task.healthy === false || taskCrashed) {
        logger.debug('[shared-container] container unhealthy, upgrading', {projectId: project.id});
        analytics.track('Error: SharedContainer Project Preview Unhealthy - Redeploying', {
            projectId: project.id,
            userId: user?.id,
        }, user);
        return upgrade(project, logger);
    }
}

async function handleHealthy(project: IProjectDoc, environmentName: string | null | undefined, version: string) {
    const service = getProjectPreviewContainerService(project);
    const newTaskHandle = project.getDeploymentData(`container.${service.newTaskHandleKey}`, environmentName);
    if (!newTaskHandle) {
        await Project.updateDeploymentData(project._id!, 'container', {
            version
        });
        return;
    }
    logger.debug('[shared-container] checking status of upgraded task', { environmentName });
    try {
        const task = await service.getTask(newTaskHandle);
        // verify that the new task is healthy
        logger.debug('[shared-container] upgraded task health:', { healthy: task.healthy, projectId: project.id, environmentName });
        if (task.healthy) {
            await registerUrl(project, service, newTaskHandle, environmentName);
            const prevTaskHandle = project.getDeploymentData(`container.${service.taskHandleKey}`, environmentName);
            await Project.updateDeploymentData(project._id!, 'container', {
                [service.newTaskHandleKey]: null,
                newTaskCreatedAt: null,
                [service.prevTaskHandleKey]: prevTaskHandle,
                [service.taskHandleKey]: newTaskHandle,
                hibernating: false,
                status: ContainerStates.running,
                version
            }, environmentName);
            logger.debug('[shared-container] finishing upgrade', { projectId: project.id, environmentName });
            if (prevTaskHandle) {
                await service.removeTask(prevTaskHandle);
            }
            await updateProjectSettings(project);
        }
    } catch (err) {
        logger.debug('[shared-container] error checking upgraded task', { projectId: project.id, environmentName, err });
    }
}

async function upgradeContainer(project: IProjectDoc, environmentName: string | null | undefined, buildLogger?: winston.Logger) {
    buildLogger?.debug('[shared-container] upgrading container...', { projectId: project.id, environmentName });

    await Project.updateDeploymentData(project._id!, 'container', {
        newTaskCreatedAt: new Date()
    });

    const service = getProjectPreviewContainerService(project);
    // kick off the upgrade by creating new task
    const taskHandle = await service.createTask(project, environmentName, deleteContainer, buildLogger);

    // get most up-to-date project details
    project = (await Project.findById(project._id!))!;
    const existingTaskHandle = project.getDeploymentData(`container.${service.taskHandleKey}`, environmentName);
    const existingNewTaskHandle = project.getDeploymentData(`container.${service.newTaskHandleKey}`, environmentName);
    if (existingNewTaskHandle) {
        buildLogger?.debug('[shared-container] removing existing upgrade task handle', { existingNewTaskHandle });
        await service.removeTask(existingNewTaskHandle);
    }

    buildLogger?.debug('[shared-container] created upgraded task', { projectId: project.id, environmentName, taskHandle });

    // Only updating the container preview URL if: force is enabled, or there isn't a URL currently set
    if (config.features.forceUpdateContainerUrl || !project.getDeploymentData<string>('container.internalUrl')) {
        const containerUrl = await service.getContainerUrl(project, taskHandle);
        project = (await Project.updateDeploymentData(project._id!, 'container', {
            url: containerUrl,
            internalUrl: containerUrl,
        }))!;
    }

    await Project.updateDeploymentData(project._id!, 'container', {
        [service.newTaskHandleKey]: taskHandle,
        newTaskCreatedAt: new Date(),
        lastUpgradeAt: new Date(),
        hibernating: false,
        lastActivity: null,
        status: _.isEmpty(existingTaskHandle) ? ContainerStates.starting : ContainerStates.restarting,
    }, environmentName);
}

export async function upgrade(project: IProjectDoc, buildLogger?: winston.Logger) {
    await Promise.all(getProjectEnvironments(project).map(environmentName => {
        return upgradeContainer(project, environmentName, buildLogger);
    }));
}

export async function upgradeIfNeeded(project: IProjectDoc, buildLogger?: winston.Logger) {
    const service = getProjectPreviewContainerService(project);
    return Promise.all(getProjectEnvironments(project).map(async (environmentName) => {
        buildLogger?.debug('[shared-container] checking if we should upgrade...', { projectId: project.id, environmentName });
        if (!project.getDeploymentData(`container.${service.taskHandleKey}`, environmentName)) {
            await upgradeContainer(project, environmentName, buildLogger);
            await updateProjectSettings(project);
        }
    }));
}

export async function webhookHandler(project: IProjectDoc, user: IUserDoc | undefined, data: any, environmentName?: string | null) {
    if (data.action === 'lifecycleEvent') {
        logger.debug('[shared-container] got build progress:', { event: data.event, projectId: project.id, environmentName });
        await Project.updateDeploymentData(project._id!, 'container', {
            buildProgress: data.event,
            lastActivity: new Date()
        }, environmentName);
        if (data.event === 'initialized') {
            const service = getProjectPreviewContainerService(project);
            // register url if it's a first time deploy
            const taskHandle = project.getDeploymentData(`container.${service.taskHandleKey}`, environmentName);
            const newTaskHandle = project.getDeploymentData(`container.${service.newTaskHandleKey}`, environmentName);
            if ((taskHandle || newTaskHandle) &&
                (project.getDeploymentData<boolean>('container.healthy', environmentName) === null ||
                    !taskHandle || !newTaskHandle)) {
                await registerUrl(project, service, taskHandle ?? newTaskHandle, environmentName);
            }
        }
    } else if (data.action === 'health') {
        if (project.getDeploymentData<boolean>('container.healthy') === null && data.healthy) {
            analytics.track('SharedContainer Project Preview Live', {
                projectId: project.id,
                userId: user?.id
            }, user);
        }
        const currentStatus = project.getDeploymentData<string>('container.status', environmentName);
        const updatedProject = (await Project.updateDeploymentData(project._id!, 'container', {
            healthy: data.healthy, // TODO what if webhook is from upgrade task
            status: data.healthy && currentStatus === ContainerStates.starting ? ContainerStates.running : currentStatus
        }, environmentName))!;
        if (data.healthy) {
            await handleHealthy(updatedProject, environmentName, data.version);
            await checkInactivity(updatedProject, user);
        } else if (data.fatal) {
            await handleUnhealthy(updatedProject, user, environmentName, data.fatal);
        } else {
            // give AWS time to notice we're unhealthy
            setTimeout(async () => {
                try {
                    await handleUnhealthy(updatedProject, user, environmentName);
                } catch (err) {
                    logger.error('[shared-container] error handling unhealthy', { projectId: project.id, err, errorMessage: (err as any)?.message });
                }
            }, 10000);
        }
    } else if (data.action === 'activity') {
        logger.debug('[shared-container] got activity update', { projectId: project.id });
        await Project.updateDeploymentData(project._id!, 'container', {
            lastActivity: new Date()
        }, environmentName);
    } else if (data.action === 'ssgState') {
        logger.debug('[shared-container] got ssgStatus update', {projectId: project.id, data});
        await Project.updateDeploymentData(project._id!, 'container', _.pick(data, ['ssgState', 'ssgRestartNeeded']), environmentName);
    }
}

export async function hibernateContainer(project: IProjectDoc, user: IUserDoc | undefined, environmentName?: string | null) {
    const loadingUrl = environmentName
        ? `${config.server.clientOrigin}/project/${project.id}/env/${environmentName}/loading`
        : `${config.server.clientOrigin}/project/${project.id}/loading`;
    logger.debug('[shared-container] hibernating container', { projectId: project.id, loadingUrl });
    await Promise.all(getRoutedUrls(project, environmentName).map(host => {
        logger.debug('[shared-container] redirecting', { projectId: project.id, host, loadingUrl });
        return routerService.redirect(host, loadingUrl);
    }));
    await deleteContainer(project, user, environmentName, logger, false);
    await Project.updateDeploymentData(project._id!, 'container', {
        hibernating: true,
        healthy: null,
        status: ContainerStates.hibernating
    }, environmentName);
    analytics.track('SharedContainer Hibernating', {
        projectId: project.id,
        userId: user?.id,
        metrics: project.metrics,
        classifications: project.classificationGroups
    }, user);
}

async function checkInactivity(project: IProjectDoc, user: IUserDoc | undefined) {
    const allContainerEnvironments = getProjectEnvironments(project);
    const shouldHibernate = _.get(project, 'shouldHibernate', true);
    const healthy = project.getDeploymentData('container.healthy');
    const lastActivityDate = _.max(allContainerEnvironments.map(environmentName => {
        return project.getDeploymentData<Date>('container.lastActivity', environmentName);
    }));
    const containerMaxInactivityTime = (project.containerMaxInactivityTimeInMinutes ?? 30) * 60 * 1000;
    if (shouldHibernate && lastActivityDate && (new Date().getTime() - lastActivityDate.getTime()) > containerMaxInactivityTime && healthy !== null) {
        logger.debug('[shared-container] container inactive, shutting down', { lastActivityDate, projectId: project.id });
        await Promise.all(allContainerEnvironments.map(environmentName => hibernateContainer(project, user, environmentName)));
    }
}

export type DeleteContainerDelegate = typeof deleteContainer;

export async function deleteContainer(
    project: IProjectDoc,
    user: IUserDoc | undefined,
    environmentName: string | null | undefined,
    buildLogger?: winston.Logger,
    shouldUnregisterUrl = true
) {
    try {
        if (!project.getDeploymentData('container', environmentName)) {
            return;
        }
        if (shouldUnregisterUrl) {
            await Promise.all(getRoutedUrls(project, environmentName).map(async (host) => {
                buildLogger?.debug('[shared-container] unregistering router urls', {projectId: project.id, environmentName});
                await routerService.unregister(host);
            }));
        }
        const service = getProjectPreviewContainerService(project);
        const taskHandle = project.getDeploymentData(`container.${service.taskHandleKey}`, environmentName);
        buildLogger?.debug('[shared-container] removing task', { projectId: project.id, environmentName, taskHandle });
        if (taskHandle) {
            await service.removeTask(taskHandle);
        }
        const newTaskHandle = project.getDeploymentData(`container.${service.newTaskHandleKey}`, environmentName);
        if (newTaskHandle) {
            buildLogger?.debug('[shared-container] removing task', { projectId: project.id, environmentName, newTaskHandle });
            await service.removeTask(newTaskHandle);
        }
        buildLogger?.debug('[shared-container] removed tasks', { projectId: project.id, environmentName });
        const prevTaskHandle = project.getDeploymentData(`container.${service.taskHandleKey}`, environmentName) ??
            project.getDeploymentData(`container.${service.newTaskHandleKey}`, environmentName);
        await Project.updateDeploymentData(project._id!, 'container', {
            [service.taskHandleKey]: null,
            [service.newTaskHandleKey]: null,
            [service.prevTaskHandleKey]: prevTaskHandle,
            newTaskCreatedAt: null,
            healthy: null,
            lastActivity: null,
            hibernating: true,
            status: ContainerStates.hibernating
        }, environmentName);
    } catch (err) {
        analytics.track('Error: Container: delete failed', {
            projectId: project.id,
            userId: user?.id,
            error: (err as any)?.message
        }, user);
        throw err;
    }
}

export async function initializeContainerEnvironments() {
    await forEachPreviewContainerService(service => service.initializeContainerEnvironment?.());
}

export async function create(project: IProjectDoc, environmentName: string | null | undefined, buildLogger?: winston.Logger) {
    const service = getProjectPreviewContainerService(project);
    const taskHandle = await service.createTask(project, environmentName, deleteContainer, buildLogger);
    const containerUrl = await service.getContainerUrl(project, taskHandle);
    await Project.updateDeploymentData(project._id!, 'container', {
        [service.taskHandleKey]: taskHandle,
        url: containerUrl,
        internalUrl: containerUrl,
        hibernating: false,
        status: ContainerStates.starting
    }, environmentName);
    await updateProjectSettings(project);
}

export async function checkHealth(project: IProjectDoc, user: IUserDoc | undefined, environmentName?: string | null, warmup = true) {
    try {
        const result = await containerService.health(project, user, environmentName, warmup);
        if (result?.status === 'ok' &&
            project.getDeploymentData<string>('container.status', environmentName) !== ContainerStates.running) {
            await Project.updateDeploymentData(project._id!, 'container', {
                status: ContainerStates.running
            }, environmentName);
        }
        return {
            status: result?.status === 'ok'
        };
    } catch (_err) {
        return {
            status: false
        };
    }
}

async function updateProjectSettings(project: IProjectDoc) {
    // Update project settings based freshly run container's capabilites.
    // Here we can indicate that new features are now supported because a new container spun up.
    // This is needed because a container might be running for a while without hibernation and
    // we need a way to know if a running container has certain features enabled for it.
    // For example:
    // We want to enable code editor in UI only when running container has been updated and
    // running latest code that supports the code editor.
    let projectChanged = false;
    if (config.features.studioCodeEditor && project.widget.codeEditorEnabled === undefined) {
        project.widget.codeEditorEnabled = true;
        projectChanged = true;
    }
    if (config.features.studioCodeEditor && project.widget.codeEditorActionsEnabled === undefined) {
        project.widget.codeEditorActionsEnabled = true;
        projectChanged = true;
    }
    if (projectChanged) {
        return project.save();
    }
}
