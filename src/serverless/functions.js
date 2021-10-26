const _ = require('lodash');

const analytics = require('../services/analytics/analytics');
const Project = require('../models/project.model').default;
const User = require('../models/user.model').default;
const buildContentful = require('./cms/contentful').buildCMS;
const buildDatoCMS = require('./cms/datocms').buildCMS;
const buildSanity = require('./cms/sanity').buildCMS;
const fetchDevTo = require('./cms/devto').fetchDevTo;
// const fetchGoogleDocs = require('./cms/google').fetchGoogleDocs;
const fetchJoboxData = require('./cms/jobox').fetchJoboxData;
const logger = require('../services/logger');
const ContentfulProjectService = require('../services/contentful-services/contentful-project-service');

function pullCms(project, ssgId, cmsId, options) {
    let promise = Promise.resolve([]);

    if (cmsId && !ssgId) {
        throw {status: 500, name: 'BuildUnavailable', message: `SSG not provided for project ${project.id}`};
    }

    if (cmsId === 'contentful') {
        const preview = _.get(options, 'preview', false);
        const space = ContentfulProjectService.getProjectSpaces(project)[0];
        const spaceId = _.get(space, 'spaceId');
        // for backward compatibility use deployKey
        const deployKey = (
            preview ?
                _.get(space, 'previewApiKey') :
                _.get(space, 'deliveryApiKey')
        ) || _.get(space, 'deployKey');

        if (!spaceId || !deployKey) {
            throw {status: 500, name: 'BuildUnavailable', message: `Not all options available for remote build project ${project.id}. spaceId: ${spaceId} deployToken exist: ${!!deployKey}`};
        }

        let environment = _.get(space, 'environment', 'master');
        const environmentName = options.environment;
        if (environmentName) {
            environment = project.getDeploymentData('contentful.environment', environmentName, environment);
        }

        options = _.assign({}, options, {
            environment
        });

        promise = buildContentful(spaceId, ssgId, deployKey, options);
    } else if (cmsId === 'datocms') {
        const token = _.get(project, 'deploymentData.datocms.readwriteToken');

        if (!token) {
            throw {status: 500, name: 'BuildUnavailable', message: `DatoCMS token not provided for ${project.id}`};
        }

        promise = buildDatoCMS(ssgId, token, options);
    } else if (cmsId === 'sanity') {
        const environmentName = options.environment;
        const projectId = project.getDeploymentData('sanity.projectId', environmentName);
        const token = project.getDeploymentData('sanity.deployKey', environmentName);
        const dataset = project.getDeploymentData('sanity.dataset', environmentName, 'production');
        const studioUrl = project.getDeploymentData('sanity.url', environmentName);

        if (!token) {
            throw {status: 500, name: 'BuildUnavailable', message: `Sanity token not provided for ${project.id}`};
        }

        options = _.assign({
            dataset: dataset,
            studioUrl: studioUrl
        }, options);

        promise = buildSanity(projectId, ssgId, token, options);
    }

    return promise;
}

function pullDataSource(project, ssgId, cmsId, options) {
    const dataType = _.get(project, 'importData.dataType');

    if (dataType === 'devto') {
        return User.findUserById(project.ownerId).then(user => {
            const connection = _.find(user.connections, {type: 'devto'});
            const accessToken = _.get(connection, 'accessToken');
            if (!accessToken) {
                throw {status: 500, name: 'BuildUnavailable', message: `DEV token not provided for ${project.id}`};
            }
            return fetchDevTo(user, ssgId, accessToken, options);
        });
    } else if (dataType === 'googledocs') {
        return User.findUserById(project.ownerId).then(user => {
            const connection = _.find(user.connections, {type: 'google'});
            const accessToken = _.get(connection, 'accessToken');
            const refreshToken = _.get(connection, 'refreshToken');
            if (!accessToken || !refreshToken) {
                throw {status: 500, name: 'BuildUnavailable', message: `Google token not provided for ${project.id}`};
            }
            const docId = _.get(project, 'importData.settings.docId');
            // return fetchGoogleDocs(docId, accessToken, refreshToken, user, options);
            throw new Error('googledocs disabled');
        });
    } else if(dataType === 'jobox') {
        return fetchJoboxData(project, options);
    }

    return Promise.resolve([]);
}

function findProjectOrFail(projectId, params) {
    const {byName, previewId} = params || {};
    let query;
    if (byName) {
        query = {
            'deploymentData.container.name': projectId,
            'deploymentData.container.lastPreviewId': previewId
        };
    } else {
        query = {_id: projectId};
    }
    return Project.findOne(query).then(project => {
        if (!project) {
            throw {status: 404, name: 'ProjectNotFound', message: `Project with ${byName ? 'name' : 'id'} '${projectId}' not found`, level: 'warn'};
        }
        return project;
    });
}

const versionDefaults = [{
    // ver: 1
    wrap: false  // in stackbit-pull ver: 1, the returned object is an array
}];

function backwardCompatibleParams(params) {
    const version = _.toNumber(_.get(params, 'ver', 1));
    if (!_.isNumber(version)) {
        throw {status: 400, name: 'BadRequest', message: `'ver' parameter must be number, '${version}' was given`};
    }

    const resolveLinks = _.get(params, 'resolveLinks', true);

    params = _.assign({
        metadata: false,
        dataFormat: 'file',
        wrap: true,  // from stackbit-pull ver: 2, the returned object is an object (not implemented yet)
        resolveLinks: resolveLinks,
        allObjects: !resolveLinks
    }, versionDefaults[version - 1], params);

    params = _.mapValues(params, (value, key, object) => {
        // when parameter comes via query string, its value can be string: "false", change it to false
        if (value === 'false') {
            value = false;
        }
        return value;
    });

    return params;
}

module.exports = {
    pull: (projectId, params) => {
        params = backwardCompatibleParams(params);
        logger.debug('pull function params', _.assign({projectId: projectId}, params));
        return findProjectOrFail(projectId, params).then(project => {
            const projectId = project.id;
            const projectApiKeys = _.get(project, 'APIKeys', []);
            const projectApiKey = _.find(projectApiKeys, ['key', params.apiKey]);

            if (!projectApiKey) {
                throw {status: 404, name: 'ProjectNotFound', message: `API key ${params.apiKey} for project ${projectId} not found`};
            }

            const cmsId = _.get(project, 'wizard.cms.id');
            const ssgId = _.get(project, 'wizard.ssg.id');

            analytics.track('Stackbit Functions Pull Triggered', { projectId: projectId, cms: cmsId }, { id: project.ownerId.toString() });

            // deployments.callDeploymentMethodForProject('setDeploymentBuildProgress', project, 'pull').catch(error => {
            //     logger.error('[serverless functions] pull(): failed to update project build process', {projectId: projectId, userId: project.ownerId.toString(), error: error});
            // });

            return Promise.all([
                pullCms(project, ssgId, cmsId, params),
                pullDataSource(project, ssgId, cmsId, params)
            ]).then((results) => {
                analytics.track('Stackbit Functions Pull Success', { projectId: projectId, cms: cmsId }, { id: project.ownerId.toString() });
                const data = _.flatten(results);
                if (params.wrap) {
                    return { projectId, data };
                }
                return data;
            }).catch((err) => {
                analytics.track('Stackbit Functions Pull Error', { projectId: projectId, reason: err.message }, { id: project.ownerId.toString() });
                throw err;
            });
        });
    }
};
