const _ = require('lodash');
const url = require('url');
const querystring = require('querystring');
const Project = require('../../models/project.model').default;
const User = require('../../models/user.model').default;
const CollaboratorRole = require('../../models/collaborator-role.model').default;
const ResponseError = require('../response-errors');
const logger = require('../../services/logger');
const config = require('../../config').default;
const analytics = require('../../services/analytics/analytics');
const googleService = require('../../services/google-services/google-service');
const deployments = require('../../services/deploy-services/deployments');
const cmsTypes = require('../../services/deploy-services/cmss');
const { getSitePreviewUrl } = require('../../services/deploy-services/container-service');
const { makeAction, actionPermission } = require('../../services/editor-services/editor-action-service');
const errorUtils = require('../../services/utils/error.utils');

const makeWidgetResponse = (req, project) => {
    const polling = req.query.polling;
    const edit = req.query.edit;
    const origin = req.query.origin || '';
    const urlParts = url.parse(origin);
    const queryParts = querystring.parse(urlParts.query);
    const environmentName = getEnvironmentNameFromUrl(project, urlParts);
    const isPreviewHost = urlParts.hostname.match(/(.*?)--(.*?).stackbit.(dev|local)/);
    const isPreview = Boolean(queryParts.preview) || isPreviewHost;
    const {checkCmsChanges} = req.body || {};
    const promiseQueue = [
        projectObjectForWidgetResponse({
            isPolling: Boolean(polling),
            originUrl: urlParts,
            project,
            user: req.user,
            environmentName
        })
    ];

    if (checkCmsChanges) {
        promiseQueue.push(
            cmsTypes.baseInvokeContentSourcesWithProject('hasChanges', project, req.user, checkCmsChanges)
                .then(hasChanges => ({error: null, hasChanges}))
                .catch(error => ({error: error.name || 'Error', hasChanges: null}))
        );
    }

    return Promise.all(promiseQueue).then(([widgetResponse, cmsChanges]) => {
        widgetResponse.viewingVersion = queryParts.preview ? widgetResponse.latestVersion : widgetResponse.publishedVersion;
        widgetResponse.page = {
            previewPage: isPreview && !edit,
            editPage: Boolean(edit),
            isLatestPreview: isPreviewHost || queryParts.preview === project.getDeploymentData('container.lastPreviewId', environmentName)
        };
        widgetResponse.cms = cmsChanges;

        return widgetResponse;
    });
};

function checkCmsAccess(user, project) {
    return cmsTypes.baseInvokeContentSourcesWithProject('hasAccess', project, user)
        .then(permissions => {
            return permissions;
        }).catch(err => err);
}

function getProjectOwnerObject(user, project) {
    const userIsOwner = user._id.toString() === project.ownerId.toString();

    // If the requesting user is the owner, we already have all the information
    // we need to populate the `owner` object.
    if (userIsOwner) {
        return {
            id: user._id,
            email: user.email
        };
    }

    // If not, we need to fetch the owner record first.
    return User.findUserById(project.ownerId).then(user => {
        return {
            id: project.ownerId,
            email: user.email
        };
    });
}

function getEnvironmentNameFromUrl(project, originUrl) {
    return _.first(Object.keys(_.get(project, 'environments', {})).map(environmentId => {
        if (_.get(project, `environments.${environmentId}.container.url`).includes(originUrl.hostname)) {
            return environmentId;
        }
        return null;
    }).filter(Boolean));
}

function projectObjectForWidgetResponse ({isPolling, originUrl, project, user, environmentName}) {
    const dataSources = [];
    const cmsId = _.get(project, 'wizard.cms.id');
    const previewUrl = getSitePreviewUrl(project, _.get(originUrl, 'pathname'));
    const deploymentId = _.get(project, 'wizard.deployment.id', null);
    // filter wizard & deploymentData which needed for widget
    const wizard = ['deployment', 'repository', 'cms'].reduce((obj, key) => {
        const wizardData = project.wizard[key];
        if (wizardData) {
            obj[key] = _.pick(wizardData, ['id', 'title']);
        }
        return obj;
    }, {});
    const deploymentData = Object.keys(project.deploymentData).reduce((obj, key) => {
        switch (key) {
        case 'github':
            obj[key] = {
                url: project.getDeploymentData('github.url', environmentName),
                transferStatus: project.getDeploymentData('github.transferStatus', environmentName),
                transferRequestDate: project.getDeploymentData('github.transferRequestDate', environmentName)
            };
            break;
        case 'netlify':
            obj[key] = {
                buildProgress: project.getDeploymentData('netlify.buildProgress', environmentName),
                buildLog: project.getDeploymentData('netlify.buildLog', environmentName),
                url: project.getDeploymentData('netlify.url', environmentName),
                claimToken: project.getDeploymentData('netlify.claimToken', environmentName)
            };
            break;
        default:
            break; // no need for now to add other deployments
        }
        return obj;
    }, {});
    const widgetProject = {
        id: project.id,
        url: project.siteUrl,
        name: project.name,
        status: project.buildStatus,
        updatedAt: project.deployedAt,
        createdAt: project.createdAt,
        allowedHosts: project.allowedHosts,
        publishedVersion: project.getDeploymentData('container.publishedVersion', environmentName),
        latestVersion: Project.latestContentVersion(project, environmentName),
        contentUpdatedAt: Project.latestContentUpdatedDate(project, environmentName),
        importDataType: _.get(project, 'importData.dataType'),
        deploymentData,
        wizard,
        previewUrl,
        cmsId,
        dataSources,
        deploymentId,
        hasBuildLogs: deploymentId === 'netlify',
        availableStatuses: [],
        buildStatusMessage: deploymentId ? project.getDeploymentData(`${deploymentId}.status_message`, environmentName) : '',
        internalUrl: project.getDeploymentData('container.internalUrl', environmentName),
        hasHMR: project.getDeploymentData('container.hasHMR', environmentName, false),
        hmrUrl: project.getDeploymentData('container.hmrUrl', environmentName, ''),
        hmrPath: project.getDeploymentData('container.hmrPath', environmentName, ''),
        hmrSocketType: project.getDeploymentData('container.hmrSocketType', environmentName, 'socket.io'),
        // deployedAt is actual mark that project has been deployed, if value is not set - project isn't deployed
        isDeployed: project.deployedAt,
        hibernating: project.getDeploymentData('container.hibernating', environmentName)
    };

    const publishingVersion = project.getDeploymentData('container.publishingVersion', environmentName);
    if (publishingVersion) {
        widgetProject.publishingVersion = publishingVersion;
    }

    widgetProject.features = _.omit(project.widget.toJSON(), ['disabledFeatures', 'netlifyInject']);

    widgetProject.features.buttons = [];
    widgetProject.features.actions = [];

    if (user) {
        widgetProject.user = {
            id: user._id,
            name: user.displayName || user.email,
            authProvider: user.authProvider
        };
    }

    const docsProject = project.getDeploymentData('container.googledocs', environmentName);
    if (docsProject) {
        dataSources.push({
            id: 'googledocs',
            title: 'Google Docs',
            url: `https://docs.google.com/document/d/${docsProject.docId}`,
            imageUrl: 'https://assets.stackbit.com/wizard/cms/docs.svg'
        });
    }
    const repoTransferStatus = project.getDeploymentData(`${wizard.repository.id}.transferStatus`);
    if (cmsId) {
        const cmsSpaces = project.getDeploymentData(`${cmsId}.spaces`, environmentName);
        if (!_.isEmpty(cmsSpaces)) {
            dataSources.push(...cmsSpaces.map(space=>({
                id: cmsId,
                title: space.spaceName,
                url: space.url,
                imageUrl: `https://assets.stackbit.com/wizard/cms/${cmsId}.svg`,
                iconUrl: `https://assets.stackbit.com/wizard/cms/${cmsId}-icon.svg`
            })));
        } else {
            dataSources.push({
                id: cmsId,
                title: _.get(project, 'wizard.cms.title'),
                url: project.getDeploymentData(`${cmsId}.url`, environmentName),
                imageUrl: `https://assets.stackbit.com/wizard/cms/${cmsId}.svg`,
                iconUrl: `https://assets.stackbit.com/wizard/cms/${cmsId}-icon.svg`,
                disabled: cmsId === 'git' && repoTransferStatus === 'initiated'
            });
        }

        if (previewUrl) {
            widgetProject.features.buttons.push({
                id: 'edit',
                title: 'Edit Site',
                value: previewUrl
            });
        }
    }

    // feature is enabled for transferred none git project
    widgetProject.features.editorDeepLinksEnabled = !(cmsId === 'git' && repoTransferStatus === 'initiated');

    // enable code editor only if a preview branch is present
    widgetProject.features.codeEditorEnabled = widgetProject.features.codeEditorEnabled && project.hasPreviewBranch();

    // deprecated statuses
    /*const statusesForImportedProject = [
        {name: 'queued', label: 'Queued'},
        {name: 'building', label: 'Building'},
        {name: 'live', label: 'Site is live'}
    ];
    const defaultStatuses = [
        {name: 'queued', label: 'Queued'},
        {name: 'building', label: 'Warming up'},
        {name: 'pull', label: 'Pulling content'},
        {name: 'ssgbuild', label: 'Building'},
        {name: 'publish', label: 'Wrapping up'},
        {name: 'live', label: 'Site is live'}
    ];
    const statusesForProjectWithoutStepHooks = [
        {name: 'queued', label: 'Queued'},
        {name: 'building', label: 'Building'},
        {name: 'live', label: 'Site is live'}
    ];

    const statusesForContainerProject = [
        {name: 'building', label: 'Building'},
        {name: 'publish', label: 'Wrapping up'},
        {name: 'live', label: 'Site is live'}
    ];

    if (_.get(project, 'importData.dataType') === 'netlify') {
        widgetProject.availableStatuses = statusesForImportedProject;
    } else if (_.get(project, 'wizard.deployment.id', null) === 'container') {
        widgetProject.availableStatuses = statusesForContainerProject;
    } else if (_.get(project, 'deploymentData.build.hasStepHooks')) {
        widgetProject.availableStatuses = defaultStatuses;
    } else {
        widgetProject.availableStatuses = statusesForProjectWithoutStepHooks;
    }*/

    widgetProject.availableStatuses = [
        {name: 'deploying', label: 'Deploying...'},
        {name: 'live', label: 'Site deployed successfully!'},
        {name: 'failing', label: 'Deployment error'}
    ];

    if (project.collaborationInviteToken) {
        widgetProject.collaboratorInviteUrl = `${config.server.clientOrigin}/project/${project._id}/accept-collaborator-invite?token=${project.collaborationInviteToken}`;
    }

    return Promise.all([
        isPolling ? null : checkCmsAccess(user, project),
        getProjectOwnerObject(user, project)
    ]).then(([cmsAccess, owner]) => {
        widgetProject.owner = owner;

        if (cmsAccess) {
            widgetProject.hasCmsConnection = _.get(cmsAccess, 'hasConnection', false);
            widgetProject.hasCmsPermissions = _.get(cmsAccess, 'hasPermissions', false);
        }

        return widgetProject;
    });
}

module.exports = {
    getProject: (req, res) => {
        const userId = req.user.id;
        const projectId = req.params.id;
        const projectUrl = req.query.origin || '';
        const polling = req.query.polling;

        const urlParts = url.parse(projectUrl);
        let siteUrl = `${urlParts.protocol}//${urlParts.host}`;

        if (config.env === 'local') {
            siteUrl = projectUrl;
        }

        const promise = projectId
            ? Project.findProjectByIdAndUser(projectId, req.user, CollaboratorRole.Permission.ON_SITE_WIDGET)
            : Project.findProjectByAllowedHostAndOwnerOrCollaboratorId(siteUrl, userId);

        return promise
            .then(project => {
                if (!project) {
                    logger.debug('Widget get project: not found', {
                        userId, projectId, projectUrl, polling, siteUrl
                    });
                    throw ResponseError.NotFound;
                }
                return project;
            }).then(project => {
                // if user owns the project, but the request received from domain not among these defined in
                // allowedHosts, it might be that the domain of the site was changed and the site was not rebuild
                // to let us know about that. Ask the deployment to update the project and check the allowedHosts again.
                const allowedHosts = _.get(project, 'allowedHosts', []);
                const receivedHost = new URL(siteUrl).origin;
                if (!_.includes(allowedHosts, receivedHost)) {
                    logger.debug('Widget get project: site host not found in allowedHosts', {
                        userId, projectId: project.id, projectUrl, host: receivedHost, allowedHosts
                    });
                    return deployments.callDeploymentMethodForProject('updateProjectData', project, req.user).then(project => {
                        const allowedHosts = _.get(project, 'allowedHosts', []);
                        if (_.includes(allowedHosts, receivedHost)) {
                            logger.debug('Widget get project: site host not found in allowedHosts after update', {
                                userId, projectId: project.id, projectUrl, host: receivedHost
                            });
                            throw ResponseError.NotFound;
                        }
                        return project;
                    });
                }
                return project;
            }).then(project => {
                const docsData = _.get(project, 'deploymentData.container.googledocs');
                if (docsData && !polling) {
                    return googleService.validateWatcher(project, req.user)
                        .then(() => Project.findProjectByIdAndUser(project._id, req.user, CollaboratorRole.Permission.BASIC_ACCESS))
                        .catch(err => {
                            logger.error(err);
                            return project;
                        });
                }

                return project;
            })
            .then(project => {
                const docsData = _.get(project, 'deploymentData.container.googledocs');
                if (docsData) {
                    const docId = docsData.docId;
                    const queriedAt = docsData.queriedAt;

                    if (queriedAt && (Date.now() - queriedAt) < 3000) {
                        return project;
                    }

                    return googleService.getFileLatestRevision(docId, req.user)
                        .then(docVersion => {
                            const update = {
                                'googledocs.contentVersion': docVersion,
                                'googledocs.publishedAt': new Date(),
                                'googledocs.queriedAt': new Date()
                            };
                            return Project.updateDeploymentData(project._id, 'container', update);
                        })
                        .catch(err => {
                            logger.error(err);
                            return project;
                        });
                }

                return project;
            })
            .then(project => {
                return deployments.callDeploymentMethodForProject('updateProjectDeploymentData', project, req.user);
            })
            .then(project => makeWidgetResponse(req, project))
            .then(response => res.json(response))
            .catch(error => {
                if (error.name === 'CastError') {
                    error = ResponseError.NotFound;
                } else if (error.status !== 404) {
                    logger.error('error polling project', {userId: userId, projectId: projectId, projectUrl: projectUrl, error: error.message || error});
                }
                res.status(200).json({ error });
            });
    },
    getProjects: (req, res) => {
        const origin = req.query.origin || '';
        const urlParts = url.parse(origin);

        return Project.findProjectsForUser(req.user.id)
            .then(projects => {
                const projectsQueue = projects.map(project => projectObjectForWidgetResponse({
                    isPolling: Boolean(req.query.polling),
                    originalUrl: urlParts,
                    project,
                    user: req.user
                }));

                return Promise.all(projectsQueue);
            })
            .then(projects => {
                return projects.map(obj => {
                    const o = { name: obj.name, url: obj.url, id: obj.id, importData: obj.importData };

                    if (!_.get(obj, 'importData.dataType')) {
                        o.wizard = obj.wizard;
                        o.deploymentData = obj.deploymentData;
                    }

                    return o;
                });
            })
            .then(projects => res.json(projects))
            .catch(err => {
                logger.error('[Widget GetProjects] failed to get projects for user', {error: err, userId: req.user.id, origin: origin});
                return res.status(err.status || 500).json({ message: 'Failed to get projects' });
            });
    },
    makeAction: (req, res) => {
        const { action, data } = req.body;
        const originPath = req.query.path;
        const projectId = req.params.id;
        const permission = actionPermission[action];

        if (!permission) {
            const error = ResponseError.ActionError({ message: 'No permissions for action' });
            logger.error('[Project makeAction] failed', { error, userId: req.user.id, projectId, action });
            return res.status(error.status).json(error);
        }

        return Project.findProjectByIdAndUser(req.params.id, req.user, CollaboratorRole.Permission.EDIT_ACCESS)
            .then(async project => {
                if (!project) {
                    throw new errorUtils.ResponseError('NotFound');
                }

                const isOwnerOrCollaborator = (await project.getCollaboratorRole(req.user)).isAuthorized(CollaboratorRole.Permission.COLLABORATOR);
                const isAllowedAction = (await project.getCollaboratorRole(req.user)).isAuthorized(permission);

                if (!isOwnerOrCollaborator && !isAllowedAction) {
                    throw new errorUtils.ResponseError('UnsupportedOperation');
                }

                return makeAction(action, project, req.user, data, originPath).then(actionResult=>{
                    res.json(actionResult);
                    analytics.track('Widget Action Complete', {
                        projectId: project.id,
                        userId: req.user.id,
                        action: action
                    }, req.user);
                });
            }).catch(err => {
                logger.error('[Widget makeAction] failed', {error: err, userId: req.user.id, action, data});
                return res.status(err.status || 500).json({ message: _.startCase(`${action} failed`) });
            });
    }
};
