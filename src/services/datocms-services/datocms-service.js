const logger = require('../logger');
const _ = require('lodash');
const config = require('../../config').default;
const projectUtils = require('../project-services/project-utils').default;

const {AccountClient, SiteClient} = require('datocms-client');


function createSite(project, token, buildLogger, retry = 0, retryName = null) {
    const accountClient = new AccountClient(token);

    const projectName = projectUtils.uniqueAlphanumericName(project, retryName || project.name);

    logger.debug('DatoCMS: creating site', {
        name: projectName,
        projectId: project.id,
        userId: project.ownerId
    });

    return accountClient.sites.create({name: projectName}).catch(err => {
        if (_.get(err, 'body.data[0].attributes.details.code') === 'VALIDATION_UNIQUENESS') {
            if (retry < 3) {
                const copyName = projectUtils.duplicateProjectName(retryName || project.name);
                buildLogger.debug('DatoCMS: Warning: SiteNameTaken, retrying with copy-name', {copyName: copyName});
                return createSite(project, token, buildLogger, retry + 1, copyName);
            }
            if (retry < 4) {
                const copyName = projectUtils.duplicateProjectName(retryName || project.name, true);
                buildLogger.debug('DatoCMS: Warning: SiteNameTaken, retrying with random-name', {copyName: copyName});
                return createSite(project, token, buildLogger, retry + 1, copyName);
            }

            buildLogger.debug('DatoCMS: Error: SiteNameTaken, Retried 4 times, failing', {projectName: project.name});
            throw err;
        }

        buildLogger.debug('DatoCMS: Error: Cannot create site', {error: err});
        throw err;
    });
}

function createStackbitWebhook(project, token) {
    const readwriteToken = _.get(project, 'deploymentData.datocms.readwriteToken');
    const client = new SiteClient(readwriteToken);
    let webhookHostname = config.server.webhookHostname;
    return client.webhooks.create({
        events: [{
            'entity_type': 'item',
            'event_types': ['create', 'update', 'delete', 'publish', 'unpublish']
        }, {
            'entity_type': 'item_type',
            'event_types': ['update', 'delete', 'create']
        }, {
            'entity_type': 'upload',
            'event_types': ['create', 'update', 'delete']
        }],
        headers: {},
        http_basic_password: '',
        http_basic_user: '',
        name: 'stackbit-deploy-webhook',
        url: `${webhookHostname}/project/${project.id}/webhook/datocms`,
        custom_payload: null
    });
}

function deleteSite(project, token) {
    const siteId = _.get(project, 'deploymentData.datocms.siteId');
    const deployKey = _.get(project, 'deploymentData.datocms.deployKey');
    if (!siteId) {
        return Promise.resolve();
    }
    const accountClient = new AccountClient(deployKey);
    return accountClient.sites.destroy(siteId)
        .catch((err) => {
            if (err && err.statusCode === 404) {
                return true; // if site was already deleted
            }
            throw err;
        });
}

function fetchEntries(project, token) {
    const readwriteToken = _.get(project, 'deploymentData.datocms.readwriteToken');
    const client = new SiteClient(readwriteToken);
    return client.items.all({
        // "filter[ids]": "12,31",
        // "filter[type]": "44",
        // "filter[query]": "foo",
        // "version": "published"
    }, {
        'allPages': true
    });
}

module.exports = {
    createSite,
    deleteSite,
    createStackbitWebhook,
    fetchEntries
};
