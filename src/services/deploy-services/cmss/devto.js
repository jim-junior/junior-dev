const _ = require('lodash');
const ResponseErrors = require('../../../routers/response-errors');
const config = require('../../../config').default;
const logger = require('../../../services/logger');
const devtoService = require('../../../services/devto-services/devto-service'); //TODO move out to separate library
const Project = require('../../../models/project.model').default;

module.exports = {
    connect: (project, user, buildLogger) => {
        const devtoConnection = _.find(user.connections, {type: 'devto'});
        if (!devtoConnection) {
            buildLogger.error('Devto: Access token missing for project creation');
            throw ResponseErrors.DevToNotConnected;
        }

        if (!config.features.devtoWebhook) {
            return Promise.resolve(project);
        }

        buildLogger.debug('DevTo: creating webhook for Stackbit');

        const webhookHostname = config.server.webhookHostname;
        const webhookUrl = `${webhookHostname}/project/${project.id}/webhook/devto`;
        return devtoService.registerWebhook(user, webhookUrl).then((webhookId) => {
            return Project.updateDeploymentData(project._id, 'devto', {
                connected: true,
                url: 'https://dev.to/dashboard',
                webhookId,
            });
        }).catch(err => {
            console.log(err)
            buildLogger.error('DevTo: Failed to create stackbit build hooks', {err});
            throw ResponseErrors.ErrorWithDebug('DevToFailedToCreateStackbitBuildHook', err);
        });
    },
    onWebhook: (project, user, req) => {
        logger.debug('DevTo: webhook triggered for ' + project.id);
        return require('../deployments').callDeploymentMethodForProject('triggerAutoBuild', project, user, {buildType: 'content-only'});
    }
};
