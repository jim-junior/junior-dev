const _ = require('lodash');
const PQueue = require('p-queue').default;
const config = require('../../config').default;
const User = require('../../models/user.model').default;
const Project = require('../../models/project.model').default;
const CollaboratorRole = require('../../models/collaborator-role.model').default;
const { BuildLogger } = require('../build-logger');
const logger = require('../logger');
const { publishNotificationForViewers } = require('../customerio-service/customerio-transactional-service');
const { findCollaboratorNotificationByType } = require('./project-utils').default;
const { ResponseError } = require('../utils/error.utils');

const getServices = () => ({
    github: require('../github-services/github-repo'),
    datocms: require('../datocms-services/datocms-service'),
    forestry: require('../forestry-services/forestry-service'),
    contentful: require('../contentful-services/contentful-api-service'),
    sanity: require('../sanity-services/sanity-service'),
    google: require('../google-services/google-service'),
    devto: require('../devto-services/devto-service'),
    container: require('../deploy-services/container-service'),
});

function deleteProjectConnections(project, user, connectionsForRemoval, buildLogger) {
    const services = getServices();
    const logger = buildLogger || BuildLogger(project.id, user.id);
    const deploymentData = _.get(project, 'deploymentData', {});
    const internalConnections = ['devto', 'container'];

    connectionsForRemoval = _.union([...connectionsForRemoval, ...internalConnections]);

    // prevent circular dependency
    const { callPureDeploymentMethodForProject, callDeploymentMethodForProject } = require('../../services/deploy-services/deployments');

    const promises = connectionsForRemoval
        .filter(connectionId => deploymentData[connectionId])
        .map(connectionId => {
            const service = services[connectionId];
            const deployment = deploymentData[connectionId];
            const connection = user.connections.find(con => con.type === connectionId) || {};
            let promise;

            if (service || ['container', 'netlify', 'azure', 'digitalocean'].includes(connectionId)) {
                switch (connectionId) {
                case 'github':
                    promise = service.deleteRepo(project, user.githubAccessToken);
                    break;
                case 'netlify':
                case 'digitalocean':
                case 'azure':
                    promise = callPureDeploymentMethodForProject('destroy', project, user, logger);
                    break;
                // TODO Unify delete methods for CMSs and call just cmsTypes.baseInvokeContentSourcesWithProject('delete', project ...
                case 'datocms':
                    promise = service.deleteSite(project, deployment.readwriteToken);
                    break;
                case 'forestry':
                    promise = service.deleteSite(project, connection.accessToken);
                    break;
                case 'contentful':
                    promise = service.deleteSpace(project, connection.accessToken);
                    break;
                case 'sanity':
                    promise = service.deleteProject(project, connection.accessToken);
                    break;
                case 'devto':
                    promise = service.deleteProject(project, connection.accessToken);
                    break;
                case 'container':
                    if (deployment.googledocs) {
                        promise = services.google.stopWatchFile(project, user);
                    } else {
                        promise = Promise.resolve();
                    }
                    promise = promise.then(() => {
                        if (project.wizard.container?.id === 'sharedContainer') {
                            return callDeploymentMethodForProject('destroy', project, user, logger);
                        } else {
                            return service.deleteSite(deployment.name, deployment.bucket || config.container.bucket, deployment.fastlySpaceId, logger);
                        }
                    });
                    break;
                default:
                    promise = Promise.reject(new Error(`Unknown service ${connectionId}`));
                    break;
                }
            } else {
                promise = Promise.reject(new Error(`Service not found for connectionId: ${connectionId}`));
            }

            return promise
                .then(() => ({connectionId, success: true}))
                .catch((err) => {
                    logger.error(err.message, err);
                    return {connectionId, err, success: false};
                });
        });

    return Promise.all(promises)
        .then((res) => ({project, deletedConnections: res}));
}

const sendCollaboratorsEmails = async (projects, { notificationType, deployedAt }) => {
    // Customer.io limit doc - https://customer.io/docs/api/#tag/trackLimit
    // 100 requests per second
    const queue = new PQueue({
        concurrency: 80,
        intervalCap: 80,
        carryoverConcurrencyCount: true,
        interval: 1000
    });

    queue.on('active', () => {
        logger.debug(`Submitting ${notificationType} notification emails in progress`, {
            queueSize: queue.size,
            pendingQueue: queue.pending
        });
    });

    await Promise.all(projects.map(async project => {
        const collaborators = project.collaborators.filter(({
            role,
            userId,
            notifications
        }) => {
            const isAcceptedViewer = Boolean(role === CollaboratorRole.VIEWER.name && userId);

            if (!isAcceptedViewer) {
                return false;
            }

            const hasNotification = findCollaboratorNotificationByType(notifications, {
                notificationType
            });

            if (!hasNotification) {
                return isAcceptedViewer;
            }

            const notificationNeedToBeHandled = findCollaboratorNotificationByType(notifications, {
                deployedAt: deployedAt ? deployedAt : project.deployedAt,
                notificationType
            });

            return isAcceptedViewer && notificationNeedToBeHandled;
        });

        if (!collaborators.length) {
            logger.debug('All collaborators already notified', { projectId: project.id });
            return;
        }

        queue.add(async () => {
            try {
                for (const collaborator of collaborators) {
                    const user = await User.findUserById(collaborator.userId);
                    const siteURL = new URL('', project.siteUrl);
                    siteURL.searchParams.set('stackbit', user.widgetAuthToken);

                    await publishNotificationForViewers(user, {
                        projectName: project.name,
                        projectUrl: new URL(`studio/${project.id}`, config.server.clientOrigin).toString(),
                        siteUrl: siteURL.toString()
                    });
                    await project.setCollaboratorNotificationSend(collaborator.userId, notificationType);
                }
            } catch (error) {
                logger.error(`Error processing submitting ${notificationType} email task`, {
                    projectId: project.id,
                    error
                });
            }
        });
    }));


    return queue.onIdle();
}

async function submitProjectDeployedNotificationEmails(customDeployAtTime, projectId) {
    const notificationType = 'projectPublished';
    const defaultPeriod = 24 * 60 * 60 * 1000;
    const deploySince = new Date(Date.now() - (customDeployAtTime ? customDeployAtTime : defaultPeriod));

    let projects = await Project.findDeployedProjectsInLastPeriodWithViewers(deploySince);

    // customDeployAtTime and projectId is mostly used for debug
    // no need to optimise findDeployedProjectsInLastPeriodWithViewers for now
    if (projectId) {
        projects = projects.filter(({ id }) => id === projectId);
    }

    if (!projects.length) {
        logger.debug('No projects with viewers were deployed last day');
        return;
    }

    return sendCollaboratorsEmails(projects, {
        notificationType,
        deployedAt: customDeployAtTime ? new Date() : null
    });
}

async function getAccessTokenToProjectCMS(user, project) {
    const cmsId = project.wizard.cms.id;

    // some actions which is allowed (e.g. updatePage) require us to run them as user instead of admin
    // e.g. getting assets for contentful requires user access token
    // Note: this method is agnostic to type of action user want to perform, so another type of permission check has to be done on root level
    const isImpersonateAdmin = (await project.getCollaboratorRole(user)).isAuthorized(CollaboratorRole.Permission.STACKBIT_ADMIN_IMPERSONATE);
    const isSupportAdmin = (await project.getCollaboratorRole(user)).isAuthorized(CollaboratorRole.Permission.STACKBIT_SUPPORT_ADMIN);
    if (isSupportAdmin || isImpersonateAdmin) {
        user = await User.findUserById(project.ownerId);
    }

    const connection = user.getConnectionByType(cmsId);
    if (!connection) {
        logger.debug(`No connection to ${cmsId}`);
        throw new ResponseError('UserDoesNotHaveConnectionToCms');
    }


    return Promise.resolve(connection.accessToken);
}

module.exports = {
    deleteProjectConnections,
    getAccessTokenToProjectCMS,
    submitProjectDeployedNotificationEmails
};
