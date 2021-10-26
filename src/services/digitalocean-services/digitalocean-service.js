const _ = require('lodash');
const logger = require('../../services/logger');
const Project = require('../../models/project.model').default;
const { createNewApp, fetchAppDeployments, getApp, deleteApp } = require('./digitalocean-api-service');
const { getStackbitYamlFromProjectInfo } = require('../deploy-services/factory-service');

async function createSiteWithRepository(project, { accessToken }) {
    const repoId = project.wizard.repository.id;
    const repoDeploymentData = project.deploymentData[repoId];
    const { publishDir, buildCommand } = await getStackbitYamlFromProjectInfo(project);
    const envVariables = getEnvVariables(project);
    // TODO pass variables related to API based CMSs
    const envs = Object.keys(envVariables).reduce((acc, key) => {
        acc.push({
            key,
            // value has to be a string
            value: envVariables[key],
            scope: 'RUN_AND_BUILD_TIME',
            type: 'GENERAL',
        });
        return acc;
    }, []);

    // validation - https://docs.digitalocean.com/products/app-platform/references/app-specification-reference/
    const name = project.name.match(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/) ? project.name : _.kebabCase(project.name);

    return createNewApp(accessToken, {
        'spec': {
            'name': name,
            'static_sites': [{
                'name': name,
                'github': {
                    'repo': repoDeploymentData.fullName,
                    'branch': repoDeploymentData.defaultBranch,
                    'deploy_on_push': true
                },
                'build_command': project.wizard.settings.enableWidget ? './stackbit-build.sh' : buildCommand,
                'output_dir': publishDir,
                envs
            }]
        }
    });
}

async function fetchLatestDeployment(project, { accessToken }) {
    const { id } = project.deploymentData.digitalocean;
    const result = await fetchAppDeployments(accessToken, id);
    // latest deployment is always first in array
    // no need to check deployments in between
    return result.deployments?.[0] ?? {};
}

function mapPhaseToStatus(phase, project, user) {
    switch (phase) {
    case 'ACTIVE':
        return 'live';
    case 'PENDING_BUILD':
    case 'BUILDING':
    case 'PENDING_DEPLOY':
    case 'DEPLOYING':
        return 'deploying';
    // API always fetch latest site deploy
    // SUPERSEDED is previous active deploy. It can became SUPERSEDED after last deploy became ACTIVE
    // there should not be situation that APi can execute mapPhaseToStatus and pass SUPERSEDED phase, can happen only when DO API issues/delays
    // logging error and return deploying status to prevent UI blinking. On next deploy request it will get proper latest deploy status
    case 'SUPERSEDED':
        logger.error(`[DigitalOcean] mapPhaseToStatus got ${phase} phase`, { projectId: project.id, userId: user.id });
        return 'deploying';
    // API always fetch latest site deploy
    // CANCELED means that new deploy has started and previous was deploying, but now it was canceled
    // there should not be situation that APi can execute mapPhaseToStatus and pass CANCELED phase, can be only in case of DO API issues
    // logging error and return deploying status to prevent UI blinking. On next deploy request it will get proper latest deploy status
    case 'CANCELED':
        logger.error(`[DigitalOcean] mapPhaseToStatus got ${phase} phase`, { projectId: project.id, userId: user.id });
        return 'deploying';
    case 'ERROR':
        return 'failing';
    }
}

function fetchApp(project, { accessToken }) {
    const { id } = project.deploymentData.digitalocean;
    return getApp(accessToken, id);
}

function removeApp(project, { accessToken }) {
    const { id } = project.deploymentData.digitalocean;
    return deleteApp(accessToken, id);
}

function getEnvVariables(project) {
    const ssgId = project.wizard.ssg.id;
    switch (ssgId) {
    case 'hugo':
        // probably can enhance from stackbit.yml version
        // has to be > 0.80 and extended
        // default Hugo version on DO is 0.78
        return {
            HUGO_EXTENDED: '1',
            HUGO_VERSION: '0.80.0'
        };
    default:
        return {};
    }
}

async function isDOExclusiveUser(user) {
    let userProjects = await Project.findOwnProjectsForUser(user.id);
    userProjects = userProjects?.filter(({ buildStatus }) => buildStatus !== 'draft');

    if (userProjects?.length > 0) {
        return false;
    } else {
        const userConnections = user.connections ?? [];
        const deploymentConnection = userConnections.find(({ type }) => ['azure', 'netlify'].includes(type));
        return !deploymentConnection;
    }
}

module.exports = {
    createSiteWithRepository,
    fetchLatestDeployment,
    mapPhaseToStatus,
    fetchApp,
    removeApp,
    isDOExclusiveUser
};
