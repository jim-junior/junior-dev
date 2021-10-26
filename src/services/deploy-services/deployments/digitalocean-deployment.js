const { differenceInSeconds } = require('date-fns');
const config = require('../../../config').default;
const logger = require('../../../services/logger');
const { delayPromise } = require('../../utils/code.utils');
const { isKnownError } = require('../../utils/error.utils');
const Project = require('../../../models/project.model').default;
const { getTokenByConnectionType } = require('../../../services/user-services/user-service');
const {
    createSiteWithRepository,
    fetchLatestDeployment,
    mapPhaseToStatus,
    fetchApp,
    removeApp
} = require('../../digitalocean-services/digitalocean-service');

const buildStatusCheckDelay = 5; // 5 sec

module.exports = {
    deploy: async (project, user, buildLogger) => {
        try {
            const deploymentId = project.wizard.deployment.id;
            const accessToken = getTokenByConnectionType(user, deploymentId);

            // there's no site_url when initial deploy started
            // if deploy passes, site_url will be created
            // site_url will be set in DB after detecting successful build
            buildLogger.debug('DigitalOcean: creating site');
            const site = await createSiteWithRepository(project, {
                accessToken,
                buildLogger
            });
            const appId = site.app.id;
            const update = {
                id: appId,
                name: site.app.spec.name,
                // DO has property deployOnPush which API set to true when creating a site
                buildHookEnabled: true,
                // no build logs for now
                buildLog: null,
                externalBuildLogLink: null,
                url: new URL(appId, config.digitalocean.userAppsURL).toString()
            };

            project = await Project.updateDeploymentData(project._id, deploymentId, update);
            project = await Project.updateBuildStatus(project._id, 'deploying', { message: null, countDeploy: false });

            return Project.updateProject(
                project.id,
                {
                    'widget.netlifyInject': project.wizard.settings.enableWidget
                },
                user.id
            );
        } catch (error) {
            buildLogger.error('DigitalOcean: deploy error', error);

            if (isKnownError(error)) {
                throw error;
            }

            throw new Error('Error deploying DigitalOcean');
        }
    },

    updateProjectData: updateProjectDeploymentData,

    updateProjectDeploymentData: updateProjectDeploymentData,

    setDeploymentBuildProgress: async function (project) {
        return project;
    },

    triggerAutoBuild: function (project, user, payload, action) {
        return Project.updateBuildStatus(project._id, 'deploying', { message: null, countDeploy: true });
    },

    triggerBuild: async function (project, user, payload) {
        return Promise.resolve(project);
    },

    createAPIKey: function (project, user) {
        return Project.createAPIKey(project._id, 'stackbit-api-key');
    },

    buildProject: function (project, user, buildLogger) {
        return require('../factory-service').buildProject(project, user, buildLogger);
    },

    destroy: async function (project, user, buildLogger) {
        buildLogger.debug('DigitalOcean: removing site');

        const deploymentId = project.wizard.deployment.id;
        const accessToken = getTokenByConnectionType(user, deploymentId);
        return removeApp(project, { accessToken });
    }
};

async function updateProjectDeploymentData(project, user, data = {}) {
    const deploymentId = project.wizard.deployment.id;
    const deploymentData = project.deploymentData?.[deploymentId];
    const { buildStatus } = project;

    if (buildStatus !== 'deploying' || !deploymentData || data.initiator !== 'studio') {
        return project;
    }

    const currentDate = Date.now();
    // fallback for buildStatusCheckDelay + 1 seconds back to current date
    // believe after we migrate to SDK it will handle rate limit automatically
    const lastDeploymentFetchTimeFallback = currentDate - (buildStatusCheckDelay + 1) * 1000;
    const lastDeploymentFetchTime = deploymentData.lastDeploymentFetchTime || lastDeploymentFetchTimeFallback;

    // preventing to many requests to DO API
    // DO API has 250 req per min, which means max 4 req per second
    // updateProjectDeploymentData is called each second
    // in case of more than 4 projects polling build status simultaneously rate limit will be exceeded
    // rate limit is counted per auth token of each user
    // buildStatusCheckDelay sec should increase amount of projects work simultaneously up to (4 X buildStatusCheckDelay)
    // TODO add proper rate limit handling on do-api-service side when DO adds response headers to API https://api.digitalocean.com/v2/apps
    // https://developers.digitalocean.com/documentation/v2/#rate-limit
    if (differenceInSeconds(currentDate, lastDeploymentFetchTime) > buildStatusCheckDelay) {
        await Project.updateDeploymentData(project._id, deploymentId, {
            lastDeploymentFetchTime: new Date(currentDate)
        });
    } else {
        return project;
    }

    const accessToken = getTokenByConnectionType(user, deploymentId);
    const deployment = await getLatestDeployment(project, user, { accessToken });
    const deploymentPhase = deployment.phase;
    const newBuildStatus = mapPhaseToStatus(deploymentPhase, project, user);
    const isLive = newBuildStatus === 'live';

    project = await Project.updateBuildStatus(project._id, newBuildStatus, {
        message: null,
        countDeploy: true,
        countDeploySuccess: isLive
    });
    project = await Project.updateDeploymentData(project._id, deploymentId, {
        deploy_id: deployment.id,
        phase: deploymentPhase
    });

    if (isLive) {
        const site = await fetchApp(project, { accessToken });
        project = await Project.updateSiteUrl(project._id, site.app.live_url);
    }

    return project;
}

async function getLatestDeployment(project, user, { accessToken, retryCount = 0 }) {
    const deployment = await fetchLatestDeployment(project, { accessToken });
    const deploymentPhase = deployment.phase;
    const buildStatus = mapPhaseToStatus(deploymentPhase, project, user);

    if (buildStatus !== 'deploying' && retryCount === 3) {
        logger.error(`DigitalOcean: [getLatestDeployment] can't get deploying status.`, {
            projectId: project.id,
            userId: user.id,
            deploymentPhase
        });
    }

    // wait for DigitalOcean to start build before setuping 'deploying' status for project
    if (buildStatus === 'deploying' || retryCount === 3) {
        return deployment;
    } else {
        await delayPromise(1000);
        return getLatestDeployment(project, user, { accessToken, retryCount: retryCount + 1 });
    }
}
