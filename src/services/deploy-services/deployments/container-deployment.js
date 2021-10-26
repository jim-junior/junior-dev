const _ = require('lodash');
const config = require('../../../config').default;
const Project = require('../../../models/project.model').default;
const { BuildLogger } = require('../../build-logger');
const logger = require('../../logger');
const projectUtils = require('../../project-services/project-utils').default;
const {publish, getSiteUrl} = require('../container-service');
const ResponseErrors = require('../../../routers/response-errors');
const analytics = require('../../analytics/analytics');
const publishContentService = require('../publish-content-service');

const uuid = require('uuid/v4');

const saveDeploymentData = (project, user, name, url, lastPreviewId) => {
    const isDocsProject = _.get(project, 'importData.dataType') === 'googledocs';
    let promise = Promise.resolve();

    if (isDocsProject) {
        // const docId = _.get(project, 'importData.settings.docId');
        // const googleService = require('../../google-services/google-service');
        // promise = googleService.getFileLatestRevision(docId, user)
        //     .then(docVersion => {
        //         _.set(project, 'deploymentData.container.googledocs', {
        //             docId,
        //             contentVersion: docVersion,
        //             publishedAt: new Date()
        //         });
        //         return Project.updateProject(project._id, project, user.id);
        //     });
        // analytics.track('Google Docs Site Created', {
        //     projectId: project.id,
        //     userId: user.id
        // }, user);
    }

    return promise
        .then(() => Project.updateSiteUrl(project.id, _.get(project, 'deploymentData.container.url', url)))
        .then(project => {
            _.set(project, 'deploymentData.container.name', name);
            _.set(project, 'deploymentData.container.url', project.siteUrl);
            _.set(project, 'deploymentData.container.lastPreviewId', lastPreviewId);

            project.name = name;
            _.set(project, 'deploymentData.container.publishedVersion', Project.latestContentVersion(project));
            return Project.updateProject(project._id, project, user.id);
        })
        .then((project) => Project.updateBuildStatus(project._id, 'live', {countDeploySuccess: true, project})); // don't need to wait for building for now
};

module.exports = {
    deploy: function (project, user, buildLogger) {
        const name = _.get(project, 'deploymentData.container.name') || projectUtils.uniqueAlphanumericName(project);
        const lastPreviewId = uuid();
        const url = getSiteUrl(name, lastPreviewId);

        buildLogger.debug(`Container: Publishing site ${url}`);

        return Project.updateDeploymentData(project.id, 'container', { name, lastPreviewId })
            .then((project) => publish(project, true, buildLogger))
            .then(() => saveDeploymentData(project, user, name, url, lastPreviewId))
            .catch((err) => {
                throw ResponseErrors.ErrorWithDebug('ContainerFailedToDeploy', err);
            });
    },
    postDeploy: function (project, user, buildLogger) {
        buildLogger.debug('Container: Post Deploy');
        const isDocsProject = _.get(project, 'importData.dataType') === 'googledocs';
        if (isDocsProject) {
            // const docId = _.get(project, 'importData.settings.docId');
            // const googleService = require('../../google-services/google-service');
            // googleService.watchFile(docId, project, user)
            //     .catch(err => {
            //         buildLogger.error(err); // do not fail build
            //     });
        }
    },
    /**
     * Triggers build process related to deployment or other action inside stackbit system
     * @param {Object} project
     * @param {Object} user
     * @param {Object} payload
     * @return {Object}
     */
    triggerAutoBuild: function(project, user, payload, action) {
        const autoBuildTriggerEnabled = _.get(project, 'settings.autoBuildTriggerEnabled');
        if (!autoBuildTriggerEnabled) {
            logger.debug('[container-deployment] triggerBuild(): auto build is disabled for the project, skipping build', {
                projectId: project.id,
                userId: user.id
            });
            return project;
        }

        logger.debug('[container-deployment] triggerBuild(): auto build is enabled for the project, starting build', {
            projectId: project.id,
            userId: user.id
        });

        return triggerBuild(project, user, payload);
    },

    triggerBuild,

    createAPIKey: function(project, user) {
        return Project.createAPIKeyWithKey(project._id, 'container-key', config.server.containerSecret);
    },

    buildProject: function(project, user, buildLogger) {
        return project;
    }
};

function triggerBuild(project, user, payload) {
    const buildLogger = new BuildLogger(project.id, user.id);
    analytics.track('Project: Triggered container rebuild', {
        deploymentType: _.get(project, 'wizard.deployment.id', null),
        containerType: _.get(project, 'wizard.container.id'),
        // backward compatible analytics
        // remove in future
        deployment: _.get(project, 'wizard.container.id', _.get(project, 'wizard.deployment.id', null)),
        projectId: project.id,
        userId: user.id
    }, user);

    return Project.updateBuildStatus(project.id, 'deploying', { message: null, countDeploy: true })
        .then(project => {
            return publishContentService.setPublishingVersionToLatestContentVersion(project);
        })
        .then(project => {
            return publish(project, false, buildLogger).then(() => project);
        })
        .then(project => {
            return publishContentService.setPublishedVersionToPublishingVersion(project);
        })
        .then(project => {
            return Project.updateBuildStatus(project.id, 'live', {countDeploySuccess: true, project});
        })
        .catch((err) => {
            buildLogger.debug('Failing Container: Publishing site:', {error: err});
            return Project.updateBuildStatus(project._id, 'failing', {message: 'Failed to publish container'}).then(project => {
                return publishContentService.removePublishingVersion(project);
            });
        });
}
