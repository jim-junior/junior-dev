const datocmsService = require('../../datocms-services/datocms-service');
const Project = require('../../../models/project.model').default;
const _ = require('lodash');
const ResponseErrors = require('../../../routers/response-errors');
const logger = require('../../logger');

module.exports = {
    preBuild: function (project, user, previewBranchName, buildLogger) {
        const datocmsConnection = _.find(user.connections, {type: 'datocms'});
        if (!datocmsConnection) {
            buildLogger.error('DatoCMS: Access token missing for site creation');
            throw ResponseErrors.DatoCMSNotConnected;
        }
        return datocmsService.createSite(project, datocmsConnection.accessToken, buildLogger).then(site => {
            return Project.updateDeploymentData(project._id, 'datocms', {
                connected: false,
                siteId: site.id,
                readwriteToken: site.readwriteToken,
                deployKey: site.accessToken,
                url: `https://${site.domain || site.internalDomain}/editor`,
                accessUrl: `https://${site.domain || site.internalDomain}/enter?access_token=${site.accessToken}`,
            });
        }).catch(err => {
            datocmsService.deleteSite(project, datocmsConnection.accessToken).catch((delErr) => {
                buildLogger.error('DatoCMS: cannot delete site', {error: delErr});
            });

            buildLogger.error('DatoCMS: Failed to create site', {error: err});
            throw ResponseErrors.ErrorWithDebug('DatoCMSFailedToCreateSite', err);
        });
    },
    contextForBuild: (project, user, buildLogger) => {
        const cmdArgs = [];
        const datocmsConnection = user.connections.find(con => con.type === 'datocms');
        if (!datocmsConnection) {
            buildLogger.error('Stackbit Factory: Missing datocms connection');
            throw {
                message: 'Stackbit Factory: Missing datocms connection'
            };
        }

        const datocmsAccessToken = datocmsConnection.accessToken;
        const datocmsReadwriteToken = _.get(project, 'deploymentData.datocms.readwriteToken');
        cmdArgs.push('--datocms-access-token=' + datocmsAccessToken);
        cmdArgs.push('--datocms-site-read-write-token=' + datocmsReadwriteToken);
        return cmdArgs;
    },
    envForDeployment: (project) => {
        const datocmsReadwriteToken = _.get(project, 'deploymentData.datocms.readwriteToken');
        return {
            DATOCMS_ACCESS_TOKEN: datocmsReadwriteToken
        };
    },
    connect: function (project, user, buildLogger) {
        const datocmsConnection = _.find(user.connections, {type: 'datocms'});
        if (!datocmsConnection) {
            buildLogger.error('DatoCMS: Access token missing for site creation');
            throw ResponseErrors.DatoCMSNotConnected;
        }

        buildLogger.debug('DatoCMS: creating webhook for Stackbit');
        return datocmsService.createStackbitWebhook(project, datocmsConnection.accessToken).then(() => {
            return Project.updateDeploymentData(project._id, 'datocms', {
                connected: true
            });
        }).catch(err => {
            buildLogger.error('DatoCMS: Failed to create Stackbit build hooks', err);
            throw ResponseErrors.ErrorWithDebug('DatoCMSFailedToCreateStackbitBuildHook', err);
        });
    },
    onWebhook: (project, user, req) => {
        if (!['publish', 'unpublish'].includes(_.get(req.body, 'event_type'))) {
            logger.debug('DatoCMS: ignoring Webhook event', {
                event_type:_.get(req.body, 'event_type'),
                entity_type: _.get(req.body, 'entity_type'),
                projectId: project.id,
                userId: user.id
            });
            return Promise.resolve(project);
        }
        return Project.updateDeploymentData(project.id, 'datocms', {
            publishedAt: new Date()
        }).then(project => {
            return require('../deployments').callDeploymentMethodForProject('triggerAutoBuild', project, user, {buildType: 'content-only'});
        }).catch(err => {
            logger.error('DatoCMS Webhook: Failed to trigger deployment build', {projectId: project.id, userId: user.id, error: err});
        });
    }
};
