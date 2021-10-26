const _ = require('lodash');
const axios = require('axios');
const uuid = require('uuid/v4');
const Project = require('../../../models/project.model').default;
const User = require('../../../models/user.model').default;
const config = require('../../../config').default;
const analytics = require('../../analytics/analytics');
const logger = require('../../logger');

const BuildError = require('../../../models/build-error.model');
const { BuildLogger } = require('../../build-logger');
const netlifyService = require('../../netlify-services/netlify-service');
const publishContentService = require('../publish-content-service');
const projectUtils = require('../../project-services/project-utils');

const NEW_DEPLOY_STATUSES = ['new', 'processing', 'enqueued'];

const getAccessToken = (project, user) => {
    let { netlifyAccessToken } = user;
    if (project?.wizard?.deployment?.settings?.sharedUser) {
        netlifyAccessToken = config.netlify.shared.accessToken;
    } else if (project.getDeploymentData('netlify.claimToken')) {
        netlifyAccessToken = config.netlify.anonAccessToken;
    }
    return netlifyAccessToken;
};

module.exports = {
    deploy: async function (project, user, buildLogger) {
        let netlifyAccessToken = getAccessToken(project, user);
        const isTokenValid = await netlifyService.validateAccessToken(netlifyAccessToken);
        const isShared = project?.wizard?.deployment?.settings?.sharedUser;
        let isAnon = false;
        if (!isTokenValid && config.netlify.anonFlowEnabled) {
            buildLogger.debug('Netlify: Creating anonymous site', {isTokenValid});
            netlifyAccessToken = config.netlify.anonAccessToken;
            isAnon = true;
        }

        buildLogger.debug('Netlify: generating repository deploy key for netlify');
        const netlifyPublicKey = await netlifyService.createPublicKey(netlifyAccessToken);
        const repositoryTypes = require('../repositories');
        await repositoryTypes.callRepositoryMethodForProject('createDeployKey', project, user, netlifyPublicKey.public_key, 'Netlify Deploy Key');
        const netlifySite = await netlifyService.createSiteWithRepository(project, {
            isAnon,
            isShared,
            userId: user.id
        }, netlifyPublicKey, netlifyAccessToken, buildLogger);
        const repoId = project?.wizard?.repository?.id;
        const repoDetails = project?.deploymentData?.[repoId];

        const buildHook = await netlifyService.createBuildHookForStackbit(netlifySite.id, netlifyAccessToken, repoDetails?.defaultBranch ?? 'master', buildLogger);
        const update = {
            anonFlow: isAnon,
            sharedFlow: isShared,
            id: netlifySite.id,
            url: netlifySite.admin_url.toLowerCase(),
            buildHookUrl: buildHook.url,
            connected: false
        };

        if (isShared) {
            update.claimToken = await netlifyService.getSharedClaimToken(project.id, user.id);
            analytics.track('Netlify Shared Site Created', {
                projectId: project.id,
                userId: user.id,
                email: user.email,
                projectName: project.name,
                claimToken: update.claimToken
            }, user);
        } else if (isAnon) {
            update.claimToken = await netlifyService.getAnonClaimToken(user.id);
            analytics.track('Netlify Anonymous Site Created', {
                projectId: project.id,
                userId: user.id,
                email: user.email,
                projectName: project.name,
                claimToken: update.claimToken
            }, user);
        }

        await Project.updateDeploymentData(project._id, 'build', { hasStepHooks: true });
        project = await Project.updateDeploymentData(project._id, 'netlify', update);
        await Project.updateSiteUrl(project._id, netlifySite.ssl_url.toLowerCase());
        return Project.updateProject(project.id, {
            'widget.netlifyInject': config.build.stackbitWidget.enabled
        }, user.id);
    },
    updateProjectData: function(project, user) {
        return getNetlifySiteIdAndToken(project, user).then(netlifyData=>{
            return netlifyService.getSite(netlifyData.siteId, netlifyData.netlifyAccessToken);
        }).then(netlifySite => {
            return netlifyService.updateProjectFromNetlifySiteOrDeploy(netlifySite, project);
        }).catch(error => {
            logger.warn('[netlify-deployment] updateProjectData(): failed to update project build status', {
                projectId: project.id, userId: user.id, error: error
            });
            return project;
        });
    },
    onWebhook: function (project, user, req) {
        const netlifyDeploy = req.body;
        const branch = netlifyDeploy?.branch;
        const environmentName = getEnvironmentForBranch(project, branch) ? branch : null;
        // ignore non production deploys
        if (!isProductionDeploy(netlifyDeploy) && !environmentName) {
            return Promise.resolve(project);
        }
        return getLatestNetlifyDeploy({ project, user, environmentName, fetchForNoneRestricted: true, recentlyScheduled: true }).then(latestDeploy => {
            // continue show deploying state
            if (!latestDeploy ||
                (NEW_DEPLOY_STATUSES.includes(latestDeploy.state) && project.buildStatus === 'deploying')) {
                return Promise.resolve(project);
            }

            return updateProjectBuildStatus('netlifyDeployStates', latestDeploy.state, project, user, latestDeploy, environmentName)
                .then(project => {
                    return netlifyService.updateProjectFromNetlifySiteOrDeploy(latestDeploy, project);
                });// todo: Commit status hooks
        }).then(project => {
            require('../split-test-service').continueSplitTestOperation(project, user);
        });
    },

    updateProjectDeploymentData: updateProjectDeploymentData,

    setDeploymentBuildProgress: function(project, buildProgress) {
        return updateProjectBuildStatus('customIntermediateStates', buildProgress, project);
    },

    /**
     * Triggers build process related to deployment or other action inside stackbit system
     * @param {Object} project
     * @param {Object} user
     * @param {Object} payload
     * @return {Object}
     */
    triggerAutoBuild: function(project, user, payload, action) {
        const autoBuildTriggerEnabled = project?.settings?.autoBuildTriggerEnabled;
        if (!autoBuildTriggerEnabled) {
            logger.debug('[netlify-deployment] triggerBuild(): auto build is disabled for the project, skipping build', {
                projectId: project.id,
                userId: user.id
            });
            return project;
        }
        return updateBuildStatusAndTriggerBuild(project, user, payload);
    },

    /**
     * Triggers build process related to any API action
     * @param {Object} project
     * @param {Object} user
     * @param {Object} payload
     * @return {Object}
     */
    triggerBuild: function(project, user, payload) {
        return updateBuildStatusAndTriggerBuild(project, user, payload);
    },

    createAPIKey: function(project, user) {
        return Project.createAPIKey(project._id, 'stackbit-api-key');
    },

    destroy: function(project, user) {
        const netlifyToken = getAccessToken(project, user);
        return netlifyService.deleteSite(project, netlifyToken);
    },
    hasAccess: function (project, user) {
        const connections = user.connections ?? [];
        const connection = connections.find(({ type }) => type === 'netlify');
        if (!connection) {
            return Promise.resolve({
                hasAccess: false,
                hasConnection: false
            });
        }

        return getNetlifySiteIdAndToken(project, user).then(({  siteId, netlifyAccessToken }) => {
            return netlifyService.getSite(siteId, netlifyAccessToken).then(() => {
                return {
                    hasAccess: true,
                    hasConnection: true
                };
            });
        }).catch(error => {
            logger.debug('[netlify-deployment] hasAccess(): error checking access to the site', {error: error, stack: error.stack});
            return {
                hasAccess: false,
                hasConnection: true
            };
        });
    }
};

function updateProjectDeploymentData (project, user) {
    const logTag = '[netlify-deployment] updateProjectDeploymentData():';
    const logData = {userId: user.id, projectId: project.id};
    return getLatestNetlifyDeploy({ project, user, recentlyScheduled: true }).then(latestDeploy => {
        if (!latestDeploy) {
            return Promise.resolve(project);
        }

        // continue show deploying state
        if (NEW_DEPLOY_STATUSES.includes(latestDeploy.state) && project.buildStatus === 'deploying') {
            return Promise.resolve(project);
        }

        // there is might be a gap between 2 deploys during deploying
        // first deploy  can be finished and second wasn't started on that tick
        // recheck again if there is no new deploys on netlify
        // otherwise call updateProjectDeploymentData again
        if (['ready', 'error'].includes(latestDeploy.state) && project.buildStatus === 'deploying') {
            return getLatestNetlifyDeploy({ project, user, recentlyScheduled: true }).then(latestDeployRetry => {
                if (latestDeploy.state === latestDeployRetry.state) {
                    return updateProjectBuildStatus('netlifyDeployStates', latestDeploy.state, project, user, latestDeploy).then(project => {
                        return netlifyService.updateProjectFromNetlifySiteOrDeploy(latestDeploy, project);
                    });
                } else {
                    return updateProjectDeploymentData(project, user);
                }
            });
        }

        return updateProjectBuildStatus('netlifyDeployStates', latestDeploy.state, project, user, latestDeploy).then(project => {
            return netlifyService.updateProjectFromNetlifySiteOrDeploy(latestDeploy, project);
        });
    }).catch(error => {
        logger.warn(`${logTag} failed to update project build status`, {logData: {...logData, error: error}});
        return Promise.resolve(project);
    });
}

function updateBuildStatusAndTriggerBuild(project, user, payload) {
    return updateProjectBuildStatus('buildTrigger', 'build', project).then(project => {
        return triggerBuild(project, user, payload);
    });
}

function getLatestNetlifyDeploy({ project, user, environmentName, fetchForNoneRestricted = false, recentlyScheduled = false }) {
    const logTag = '[netlify-deployment] getLatestNetlifyDeploy():';
    const logData = {userId: user.id, projectId: project.id};

    if (project.buildStatus === 'build-failed') {
        // logger.debug(`${logTag} project is in "failed" state`, _.assign(logData, {projectStatus: project.buildStatus}));
        return Promise.resolve(null);
    }

    return getNetlifySiteIdAndToken(project, user).then(netlifyData=>{
        if (!netlifyData) {
            return Promise.resolve(null);
        }

        if (fetchForNoneRestricted) {
            // logger.debug(`${logTag} project has no restricted webhooks, get latest deploy`, logData);
            return netlifyService.getSiteDeploys(netlifyData.siteId, netlifyData.netlifyAccessToken);
        }

        // if user has restricted webhooks (users plan does not support webhooks)
        // then poll netlify for project build status by getting the latest
        // deployment object and updating project buildStatus
        return netlifyService.hasRestrictedWebhooks(project, netlifyData.siteId, netlifyData.netlifyAccessToken).then(hasRestrictedWebhooks => {
            if (!hasRestrictedWebhooks) {
                // logger.debug(`${logTag} project has no restricted webhooks, don't fetch site deploys`, logData);
                return Promise.resolve(null);
            }
            // logger.debug(`${logTag} project has restricted webhooks, get latest deploy`, logData);
            return netlifyService.getSiteDeploys(netlifyData.siteId, netlifyData.netlifyAccessToken);
        });
    }).then(deploys => {
        let latestDeploy = getLatestDeploy(deploys, recentlyScheduled, environmentName);
        if (!latestDeploy) {
            // logger.debug(`${logTag} site has no latest deploy`, logData);
            return null;
        }
        // logger.debug(`${logTag} got latest deploy`, _.assign(logData, {
        //     projectStatus: project.buildStatus,
        //     netlifyState: latestDeploy.state
        // }));
        return latestDeploy;
    });
}

function getNetlifySiteIdAndToken(project, user) {
    const logTag = '[netlify-deployment] getNetlifySiteIdAndToken():';
    const logData = {userId: user.id, projectId: project.id};

    return User.findUserById(project.ownerId).then(owner=>{
        const netlifyDeploymentData = project?.deploymentData?.netlify;
        if (!netlifyDeploymentData) {
            // not a Netlify project
            return null;
        }

        const netlifyAccessToken = getAccessToken(project, user);
        if (!netlifyAccessToken) {
            // this shouldn't happen, but just in case
            // logger.error(`${logTag} could not acquire netlify access token`, _.assign(logData, {hasClaimToken: !!claimToken}));
            return null;
        }

        const siteId = netlifyDeploymentData?.id;
        if (!siteId) {
            // this shouldn't happen, but happened
            // Happens when project is still building and dashboard/widget is polling for updates
            // logger.error(`${logTag} netlify deployment data does not have site id`, logData);
            return null;
        }

        return {siteId, netlifyAccessToken};
    });
}

function getLatestDeploy(deploys, recentlyScheduled, environmentName) {
    // available deploy states: new, enqueued, building, ready, error
    // here we try to simulate Netlify webhooks for currently running deploy
    let latestNewOrEnqueuedDeploy = null;
    let recentFailedDeploy = null;
    let latestBuildingDeploy = null;
    let latestReadyDeploy = null;
    let latestDeploy = null;
    let relevantDeploys = environmentName ?
        deploys.filter(deploy => deploy.branch === environmentName)
        : deploys;
    _.forEach(relevantDeploys, deploy => {
        // ignore non production deploys
        if (!isProductionDeploy(deploy) && !environmentName) {
            return true;
        }
        // record latest 'new' or 'enqueued' deploy before any 'ready' deploy
        if (NEW_DEPLOY_STATUSES.includes(deploy.state)) {
            latestNewOrEnqueuedDeploy = deploy;
            if (recentlyScheduled) {
                return false;
            }
        }
        // record recent 'error' deploy before any 'ready' deploy
        if (deploy.state === 'error' && !recentFailedDeploy) {
            recentFailedDeploy = deploy;
            return false;
        }
        // once first 'building' deploy is found we are done,
        // this will be our latest deploy
        if (['uploading', 'building'].includes(deploy.state)) {
            latestBuildingDeploy = deploy;
            return false;
        }
        // once first 'ready' deploy is found we are done,
        // use it, or anything that came before
        if (deploy.state === 'ready') {
            latestReadyDeploy = deploy;
            return false;
        }
    });

    if (latestBuildingDeploy) {
        latestDeploy = latestBuildingDeploy;
    } else if (latestNewOrEnqueuedDeploy) {
        latestDeploy = latestNewOrEnqueuedDeploy;
    } else if (recentFailedDeploy) {
        latestDeploy = recentFailedDeploy;
    } else if (latestReadyDeploy) {
        latestDeploy = latestReadyDeploy;
    }

    return latestDeploy;
}

function triggerBuild(project, user, payload) {
    const branch = payload?.branch;
    const environmentName = branch && getEnvironmentForBranch(project, branch) ? branch : null;
    const buildHookUrl = project.getDeploymentData('netlify.buildHookUrl', environmentName);
    if (!buildHookUrl) {
        logger.debug('[netlify-deployment] triggerBuild(): netlify build hook url not available, skipping build', {
            projectId: project.id,
            userId: user.id
        });
        return project;
    }

    analytics.track('Project: Triggered project rebuild', {
        projectId: project.id,
        userId: user.id
    }, user);

    return axios.post(buildHookUrl, {
        buildType: payload?.buildType
    }).then(() => {
        return project;
    }).catch(error => {
        logger.warn('[netlify-deployment] triggerBuild(): netlify build hook url returned error', {
            projectId: project.id,
            userId: user.id,
            error: error.message
        });
        return project;
    });
}

function updateProjectBuildStatus(source, event, project, user, context, branch) {
    const logTag = '[netlify-deployment] updateProjectBuildStatus():';
    const logData = {source: source, event: event, projectId: project.id};
    // logger.debug(`${logTag}`, logData);

    const sourceHandlers = StateMachine?.[source];
    if (!sourceHandlers) {
        logger.error(`${logTag} received illegal source`, logData);
        return Promise.resolve(project);
    }

    const eventHandler = sourceHandlers?.[event];
    if (!eventHandler) {
        logger.error(`${logTag} received illegal event`, {logData, context});
        return Promise.resolve(project);
    }

    if (project.buildStatus === 'build-failed') {
        logger.debug(`${logTag} project is in "failed" state`, {logData: {...logData, projectStatus: project.buildStatus}});
        return Promise.resolve(project);
    }

    return eventHandler(project, user, context, branch);
}

function setProjectBuildStatusDeployingWithBuildProgress(buildProgress, project, user, netlifyDeploy, environmentName) {
    return setProjectBuildStatusDeploying(project, environmentName).then((project) => {
        const currBuildProgress = project.getDeploymentData('netlify.buildProgress', environmentName);
        const currDeployState = project.getDeploymentData('netlify.build_status', environmentName);
        const currDeployId = project.getDeploymentData('netlify.deploy_id', environmentName);
        // if current we already stored this netlify deploy, then ignore this event if:
        // - current buildProgress is the same as provided, this is because both
        //   "new" and "enqueued" netlify deploy states are translated to "queued" buildProgress
        // or
        // - current netlify state is the same as the provided, because this method could
        //   be called multiple times while polling netlify without netlify states being changed,
        //   while other events (pull, ssgbuild, etc) might asynchronously come from other sources
        //   and change buildProgress.
        if (currDeployId === netlifyDeploy.id && (currBuildProgress === buildProgress || currDeployState === netlifyDeploy.state)) {
            return Promise.resolve(project);
        }
        logger.debug(`[netlify-deployment] set project buildProgress to ${buildProgress}`, {projectId: project.id, buildProgress: buildProgress, environmentName});
        const buildLogUrl = netlifyDeploy?.log_access_attributes?.url;
        const buildLog = buildLogUrl ? buildLogUrl + '.json' : null;
        trackBuildProgress(project, user, netlifyDeploy);
        return Project.updateDeploymentData(project.id, 'netlify', {
            connected: true,
            deploy_id: netlifyDeploy.id,
            build_status: netlifyDeploy.state,
            buildProgress: buildProgress,
            buildLog: buildLog
        }, environmentName);
    });
}

function setProjectBuildStatusDeployingProgressQueuedFromBuildTrigger(project) {
    // allow external build trigger only if the project is not deploying and is one of main states
    if (!['building', 'live', 'failing'].includes(project.buildStatus)) {
        return Promise.resolve(project);
    }
    return setProjectBuildStatusDeploying(project).then((project) => {
        const buildProgress = project?.deploymentData?.netlify?.buildProgress;
        if (buildProgress === 'queued') {
            return Promise.resolve(project);
        }
        logger.debug('[netlify-deployment] set project buildProgress to queued (build trigger)', {projectId: project.id, buildProgress: 'queued'});
        return Project.updateDeploymentData(project.id, 'netlify', {
            deploy_id: null,
            build_status: null,
            buildProgress: 'queued',
            buildLog: null
        });
    });
}

function setProjectBuildProgressCustom(buildProgress, project) {
    // custom buildProgresses are anything that are not 'live', 'queued' or 'building'
    if (['queued', 'building', 'live'].includes(buildProgress)) {
        logger.error(`[netlify-deployment] illegal invocation: setProjectBuildProgressCustom() can not be called with '${buildProgress}' buildProgress`);
        return Promise.resolve(project);
    }
    // allow setting custom build progress only if the project is not deploying
    if (project.buildStatus !== 'deploying') {
        return Promise.resolve(project);
    }
    logger.debug(`[netlify-deployment] set project buildProgress to ${buildProgress}`, {projectId: project.id, buildProgress: buildProgress});
    return Project.updateDeploymentData(project.id, 'netlify', {
        buildProgress: buildProgress
    });
}

function setProjectBuildStatusDeploying(project, environmentName) {
    if (project.buildStatus === 'deploying' && !environmentName) {
        return Promise.resolve(project);
    }
    logger.debug('[netlify-deployment] set project buildStatus to deploying', {projectId: project.id, buildStatus: 'deploying'});
    return Project.updateBuildStatus(project._id, 'deploying', {message: null, countDeploy: true}).then(project => {
        return publishContentService.setPublishingVersionToLatestContentVersion(project, environmentName);
    });
}

function setProjectBuildStatusLive(project, user, netlifyDeploy, environmentName) {
    if (project.buildStatus === 'live' && !environmentName) {
        return Promise.resolve(project);
    }
    logger.debug('[netlify-deployment] set project buildStatus to live', {projectId: project.id, buildStatus: 'live', environmentName});
    trackBuildProgress(project, user, netlifyDeploy);
    return Project.updateDeploymentData(project.id, 'netlify', {
        'buildProgress': 'live',
        'deploy_id': netlifyDeploy.id,
        'build_status': netlifyDeploy.state,
        'status_message': null,
        'screenshot_url': netlifyDeploy.screenshot_url,
        'summary': netlifyDeploy.summary
    }, environmentName).then(project => {
        return updateProjectLive(project, user);
    }).then(project => {
        return publishContentService.setPublishedVersionToPublishingVersion(project, environmentName);
    });
}

function setProjectBuildStatusFailing(project, user, netlifyDeploy, environmentName) {
    if (project.buildStatus === 'failing' && !environmentName) {
        return Promise.resolve(project);
    }
    logger.debug('[netlify-deployment] set project buildStatus to failing', {projectId: project.id, buildStatus: 'failing', environmentName});
    trackBuildProgress(project, user, netlifyDeploy);
    return Project.updateDeploymentData(project.id, 'netlify', {
        'deploy_id': netlifyDeploy.id,
        'build_status': netlifyDeploy.state,
        'status_message': netlifyDeploy.error_message
    }, environmentName).then(project => {
        return Project.updateBuildStatus(project.id, 'failing');
    }).then(project => {
        return publishContentService.removePublishingVersion(project, environmentName);
    });
}

function updateProjectLive(project, user) {
    if (project?.deploymentData?.[project?.wizard?.cms?.id]?.connected !== true) {
        const buildLogger = BuildLogger(project.id, user.id);
        const cmsTypes = require('../cmss');    // require inline to remove circular dependency
        return cmsTypes.baseInvokeContentSourcesWithProject('postDeployConnect', project, user, buildLogger, true).then(() => {
            return Project.updateBuildStatus(project._id, 'live', {countDeploySuccess: true, project});
        }).catch((err) => {
            const errorMessage = err?.data?.error || 'Failed to connect CMS post deploy';
            return Project.updateBuildStatus(project._id, 'build-failed', {message: errorMessage}).then(() => {
                return BuildError.saveError(err, project.id, user.id).then(() => {
                    buildLogger.error('Post Live deployProject error', {error: err, stack: err.stack});
                    throw {message: errorMessage};
                });
            });
        });
    }
    return Project.updateBuildStatus(project._id, 'live', {countDeploySuccess: true, project});
}

function trackBuildProgress(project, user, netlifyDeploy) {
    const eventNames = {
        new: 'Project Netlify Build Queued',
        enqueued: 'Project Netlify Build Queued',
        building: 'Project Netlify Build Started',
        ready: 'Project Netlify Build Success',
        error: 'Project Netlify Build Failed'
    };
    if (!Object.keys(eventNames).includes(netlifyDeploy.state)) {
        logger.error('[netlify-deployment] trackBuildProgress(): illegal netlify build state', {projectId: project.id, userId: user.id, netlifyDeployState: netlifyDeploy.state});
        return;
    }
    const eventName = eventNames[netlifyDeploy.state];
    analytics.track(eventName, {
        projectId: project.id,
        userId: user.id,
        theme: project?.wizard?.theme?.id,
        ssg: project?.wizard?.ssg?.id,
        cms: project?.wizard?.cms?.id,
        repository: project?.wizard?.repository?.id,
        deploymentType: project?.wizard?.deployment?.id,
        containerType: project?.wizard?.container?.id,
        // backward compatible analytics
        // remove in future
        deployment: project?.wizard?.container?.id || project?.wizard?.deployment?.id,
        deploySuccessCount: project?.metrics?.deploySuccessCount,
        importDataType: project?.importData?.dataType,
        netlifyDeployState: netlifyDeploy.state,
        siteUrl: netlifyDeploy.ssl_url,
        ...(netlifyDeploy.state === 'error' ? {
            error: netlifyDeploy.error_message,
            changeTitle: netlifyDeploy.title,
            netlifyLogUrl: netlifyDeploy?.log_access_attributes?.url
        } : {})
    }, user);
}

function isProductionDeploy(deploy) {
    return deploy.context === 'production';
}

function getEnvironmentForBranch(project, branch) {
    return project?.environments?.[branch];
}

const setProjectBuildStatusDeployingBuildProgressQueued = _.partial(setProjectBuildStatusDeployingWithBuildProgress, 'queued');
const setProjectBuildStatusDeployingBuildProgressBuilding = _.partial(setProjectBuildStatusDeployingWithBuildProgress, 'building');
const setProjectBuildProgressPull = _.partial(setProjectBuildProgressCustom, 'pull');
const setProjectBuildProgressSSGBuild = _.partial(setProjectBuildProgressCustom, 'ssgbuild');
const setProjectBuildProgressPublish = _.partial(setProjectBuildProgressCustom, 'publish');

/**
 * Deployment Status and Progress StateMachine
 *
 * The StateMachine is called through sources and events each source can trigger:
 * StateMachine[event-source][event-name](project, user, netlifyDeploy)
 */
const StateMachine = {
    netlifyDeployStates: {
        new: setProjectBuildStatusDeployingBuildProgressQueued,
        enqueued: setProjectBuildStatusDeployingBuildProgressQueued,
        building: setProjectBuildStatusDeployingBuildProgressBuilding,
        ready: setProjectBuildStatusLive,
        error: setProjectBuildStatusFailing
    },
    buildTrigger: {
        build: setProjectBuildStatusDeployingProgressQueuedFromBuildTrigger
    },
    customIntermediateStates: {
        pull: setProjectBuildProgressPull,
        ssgbuild: setProjectBuildProgressSSGBuild,
        publish: setProjectBuildProgressPublish
    }
};
