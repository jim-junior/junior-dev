
const _ = require('lodash');
const uuid = require('uuid');
const dateFns = require('date-fns');

const logger = require('../logger');
const cmsTypes = require('./cmss');
const gitService = require('./git-service');
const containerService = require('./container-service');
const orchestrator = require('./container-orchestration-service');
const Project = require('../../models/project.model').default;
const projectUtils = require('../project-services/project-utils').default;
const config = require('../../config').default;


function createEnvironments(project, user, environments) {
    logger.info('[environments] creating branches', {projectId: project.id});
    const url = _.get(project, 'deploymentData.github.sshURL');
    const privateKey = _.get(project, 'deploymentData.container.deployPrivateKey');
    const publicKey = _.get(project, 'deploymentData.container.deployPublicKey');
    const { publishBranch } = project.getContainerBranches();
    return gitService.createBranches(url, privateKey, publicKey, publishBranch, environments).then(() => {
        logger.info('[environments] provisioning cms environments', {projectId: project.id});
        return cmsTypes.baseInvokeContentSourcesWithProject('provisionEnvironments', project, user, environments);
    }).then(project => {
        logger.info('[environments] creating containers', {projectId: project.id});
        return Promise.all(
            environments.map(environmentName => {
                const projectName = `${projectUtils.uniqueAlphanumericName(project, project.name)}-${environmentName}`;
                const envSubdomain = config.env === 'prod' ? '' : '.staging';
                const previewUrl = `https://preview--${projectName}${envSubdomain}.stackbit.dev`;
                const cmsId = _.get(project, 'wizard.cms.id');
                const previewBranch = project.getDeploymentData(`${cmsId}.branch`, environmentName, environmentName);
                return Project.updateDeploymentData(project.id, 'container', {
                    buildProgress: orchestrator.BuildStates.provisioningCms,
                    name: projectName,
                    lastPreviewId: uuid(),
                    url: previewUrl,
                    internalUrl: previewUrl,
                    publishBranch: environmentName,
                    previewBranch
                }, environmentName).then(project => {
                    return orchestrator.create(project, environmentName, null);
                });
            })
        );
    }).then(() => Project.findById(project.id));
}

function removeEnvironments(project, user, environments) {
    logger.info('[environments] removing branches', {projectId: project.id});
    const url = _.get(project, 'deploymentData.github.sshURL');
    const privateKey = _.get(project, 'deploymentData.container.deployPrivateKey');
    const publicKey = _.get(project, 'deploymentData.container.deployPublicKey');
    return gitService.removeBranches(url, privateKey, publicKey, environments).catch(err => {
        logger.warn('[environments] error removing branches', {projectId: project.id, err});
    }).then(() => {
        logger.info('[environments] removing containers', {projectId: project.id});
        return Promise.all(
            environments.map(environmentName => orchestrator.deleteContainer(project, user, environmentName, logger))
        ).then(() => project);
    }).then(project => {
        logger.info('[environments] removing cms environments', {projectId: project.id});
        return cmsTypes.baseInvokeContentSourcesWithProject('removeEnvironments', project, user, environments).catch(err => {
            logger.warn('[environments] error removing environments', {projectId: project.id, err});
            return project;
        });
    }).then(project => {
        project.environments = _.omit(project.environments, environments);
        return Project.updateProject(project.id, project, project.ownerId);
    }).then(() => Project.findById(project.id));
}

function removeAllEnvironments(project, user) {
    if (_.isEmpty(project.environments)) {
        return Promise.resolve(project);
    }
    const environments = Object.keys(project.environments);
    return removeEnvironments(project, user, environments);
}

function pickEnvironment(project, user, environmentName) {
    logger.info('[environments] picking environment', {projectId: project.id, environmentName});
    const url = _.get(project, 'deploymentData.github.sshURL');
    const privateKey = _.get(project, 'deploymentData.container.deployPrivateKey');
    const publicKey = _.get(project, 'deploymentData.container.deployPublicKey');
    const date = new Date();
    const timestamp = ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss'].map(f => dateFns.format(date, f)).join('');
    const tag = `stackbit-${timestamp}`;
    return cmsTypes.baseInvokeContentSourcesWithProject('migrateToEnvironment', project, user, environmentName, tag).then(project => {
        const { publishBranch: primaryPublishBranch } = project.getContainerBranches();
        logger.info(`[environments] picking ${primaryPublishBranch} branch`, {projectId: project.id, environmentName});
        let allBranches = Object.keys(project.environments).concat(primaryPublishBranch);
        return gitService.tagBranches(url, privateKey, publicKey, allBranches, tag).then(() => {
            logger.info('[environments] changing branch pointers', {projectId: project.id, environmentName});
            return gitService.updateBranchToAnother(url, privateKey, publicKey, environmentName, primaryPublishBranch);
        });
    }).finally(() => {
        logger.info('[environments] reloading container config', {projectId: project.id, environmentName});
        return containerService.reloadConfig(project, user).catch(err => {
            logger.warn('[environments] container can\'t reload config', {projectId: project.id, err});
        });
    }).then(() => project);
}

module.exports = {
    createEnvironments,
    removeEnvironments,
    removeAllEnvironments,
    pickEnvironment
};
