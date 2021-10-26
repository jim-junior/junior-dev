const _ = require('lodash');
const axios = require('axios');
const aws = require('aws-sdk');
const mime = require('mime');
const normalizeUrl = require('normalize-url');

const Project = require('../../models/project.model').default;
const config = require('../../config').default;
const containerBaseURL = config.container.internalUrl;

function containerAPI(endpoint, baseUrl, method, data, headers, logger) {
    const payload = {
        url: baseUrl + endpoint,
        method,
        headers,
        data
    };

    return axios(payload).catch((err) => {
        let error = err;
        if (err && err.response) {
            error = {
                code: err.response.status,
                data: err.response.data,
                message: _.get(err, 'response.data.error')
            };
        } else {
            error = {
                code: err.code,
                message: err.message
            };
        }
        if (logger) {
            logger.error('Failed to make containerAPI request', {url: baseUrl + endpoint, method, data, error});
        }
        throw error;
    });
}

function authContainerAPI(endpoint, user, project, data, environmentName, logger, method='POST', responseContentType) {
    const internalUrl = project.getDeploymentData('container.internalUrl', environmentName);
    const apiKey = project.APIKeys.find(key => key.name === 'container-key');
    const allData = {
        user: {
            name: _.get(user, 'displayName', config.container.shared.projectsGithubUsername),
            email: _.get(user, 'email', config.container.shared.projectsGithubEmail)
        },
        ...data
    };
    return containerAPI(endpoint, internalUrl, method, allData, {
        'Authorization': `Bearer ${_.get(apiKey, 'key', '')}`
    }, logger).then(response => {
        if (responseContentType) {
            const contentType = _.get(response, 'headers.content-type', '');
            const validType = contentType.includes(responseContentType);
            if (!validType) {
                throw new Error(`Response in wrong content type, expected ${responseContentType}, received ${contentType}`);
            }
        }
        return response.data;
    });
}

function fastlyAPI(endpoint, method, data, headers, fastlySpaceId, logger) {
    const baseUrl = config.container.fastly.apiBaseUrl + (fastlySpaceId ? fastlySpaceId : config.container.fastly.spaceId);
    return axios({
        method: method,
        url: baseUrl + endpoint,
        headers: headers
    }).then(response => {
        return response.data;
    }).catch((err) => {
        let error = err;
        if (err && err.response) {
            error = {
                code: err.response.status,
                data: err.response.data
            };
        } else {
            error = {
                code: err.code,
                message: err.message
            };
        }

        logger.error('Fastly: Error:', {endpoint: baseUrl + endpoint, response: error, headers});
        throw error;
    });
}

function uploadPage(projectName, bucket, page, logger) {
    const s3 = new aws.S3();
    const params = {
        Bucket: bucket,
        Key: `${projectName}/${page.filePath}`,
        Body: page.data,
        ACL: 'public-read',
        ContentType: mime.getType(page.filePath)
    };
    return s3.upload(params).promise()
        .then((data) => {
            logger.debug('Uploaded ' + page.filePath);
            return data;
        });
}

function listObjects(siteName, bucket, s3Instance) {
    const s3 = s3Instance || new aws.S3();
    const listParams = {
        Bucket: bucket,
        Prefix: siteName,
    };

    return s3.listObjects(listParams)
        .promise()
        .then(data => ({
            ...data,
            Contents: data.Contents.filter(file => file.Key.split('/')[0] === siteName)
        }));
}

function renameSite(siteName, bucket, fastlySpaceId, newName, logger) {
    const s3 = new aws.S3();

    return listObjects(siteName, bucket, s3)
        .then((data) => {
            const copyPromises = data.Contents.map(file => {
                const copyParams = {
                    Bucket: bucket,
                    CopySource: `${bucket}/${file.Key}`,
                    Key: file.Key.replace(siteName, newName),
                    ACL: 'public-read'
                };
                return s3.copyObject(copyParams).promise();
            });
            return Promise.all(copyPromises);
        })
        .then(() => logger.debug(`Copied from ${siteName} to ${newName}`))
        .then(() => deleteSite(siteName, bucket, fastlySpaceId, logger))
        .then(() => invalidateSite(newName, null, fastlySpaceId, logger));
}

function deleteSite(siteName, bucket, fastlySpaceId, logger) {
    const s3 = new aws.S3();

    return listObjects(siteName, bucket, s3)
        .then(data => {
            const deletePromises = data.Contents.map(file => {
                const deleteParams = {
                    Bucket: bucket,
                    Key: file.Key
                };
                return s3.deleteObject(deleteParams).promise();
            });
            return Promise.all(deletePromises);
        })
        .then(() => invalidateSite(siteName, null, fastlySpaceId, logger))
        .then((data) => {
            logger.debug(`Removed ${siteName}`);
            return data;
        });
}

function invalidateUrl(url, token) {
    return axios({
        method: 'PURGE',
        url: url,
        headers: {
            'Fastly-Key': token
        }
    }).then(response => {
        return response.data;
    });
}

function invalidateSite(projectName, url, fastlySpaceId, logger) {
    logger.debug('Publish: invalidating site');
    const token = config.container.fastly.purgeToken;
    const surrogateInvalidation = fastlyAPI('/purge', 'post', {}, {
        'Fastly-Key': token,
        'Surrogate-Key': projectName
    }, fastlySpaceId, logger);
    const urlInvalidation = url ? invalidateUrl(url, token) : Promise.resolve();
    return Promise.all([surrogateInvalidation, urlInvalidation]).then(() => {
        return new Promise((resolve, reject) => setTimeout(resolve, 150)); // delay by 150ms to make sure cache purged
    }).then(() => {
        logger.debug('Publish: done invalidating site');
    });
}

function publish(project, isFirstPublish = false, logger) {
    const siteName = _.get(project, 'deploymentData.container.name');
    const bucket = _.get(project, 'deploymentData.container.bucket', config.container.bucket);
    const fastlySpaceId = _.get(project, 'deploymentData.container.fastlySpaceId');
    const internalUrl = _.get(project, 'deploymentData.container.internalUrl', containerBaseURL);
    const previewId = _.get(project, 'deploymentData.container.lastPreviewId');

    const bundleUrl = `/${siteName}/_bundle?preview=${previewId}`;
    logger.debug('Publish: Getting bundle ', {bundleUrl, internalUrl});
    return Project.updateDeploymentData(project.id, 'container', { buildProgress: 'building' })
        .then(project => {
            return containerAPI(bundleUrl, internalUrl, 'get', {}, {}, logger).then(response => {
                logger.debug('Publish: Got bundle');
                return Project.updateDeploymentData(project.id, 'container', { buildProgress: 'publish' })
                    .then(project => {
                        return Promise.all((response || []).map(page => uploadPage(siteName, bucket, page, logger)))
                            .then(() => project);
                    });
            }).then(project => {
                if (isFirstPublish) {
                    return Promise.resolve(project);
                }
                return invalidateSite(siteName, project.siteUrl, fastlySpaceId, logger)
                    .then(() => project);
            }).then(project => {
                return Project.updateDeploymentData(project.id, 'container', {
                    buildProgress: 'live'
                });
            }).catch(err => {
                logger.error('Publish: failed to publish container site', err);
                throw err;
            });
        });
}

function getSiteUrl(name, previewId) {
    return config.env === 'local'
        ? `${config.container.internalUrl}/${name}?preview=${previewId}`
        : `https://${name}.stackbit.dev`;
}

function getSitePreviewUrl(project, path = '') {
    const uriPathParam = path === '/' ? '' : `#${path}`;
    return normalizeUrl(`${config.server.clientOrigin}/studio/${_.get(project, 'id')}${uriPathParam}`);
}

function getObject(project, user, data, environmentName) {
    const projectId = encodeURIComponent(data.projectId);
    const objectId = encodeURIComponent(data.objectId);
    return authContainerAPI(`/_object?projectId=${projectId}&objectId=${objectId}`, user, project, {}, environmentName, null, 'GET');
}

function createObject(project, user, data, environmentName) {
    return authContainerAPI('/_object', user, project, _.pick(data, ['object', 'filePath', 'modelName']), environmentName);
}

function deleteObject(project, user, data, environmentName) {
    const projectId = encodeURIComponent(data.projectId);
    const objectId = encodeURIComponent(data.objectId);
    return authContainerAPI(`/_object?projectId=${projectId}&objectId=${objectId}`, user, project, {}, environmentName, null, 'DELETE');
}

function updateObject(project, user, data, environmentName) {
    const projectId = encodeURIComponent(data.projectId);
    const objectId = encodeURIComponent(data.objectId);
    return authContainerAPI(`/_object?projectId=${projectId}&objectId=${objectId}`, user, project, {
        object: data.object
    }, environmentName, null, 'PUT');
}

function publishDrafts(project, user, data, environmentName, buildLogger) {
    return authContainerAPI('/_publish', user, project, data, environmentName, buildLogger);
}

function hasChanges(project, user, data, environmentName) {
    return authContainerAPI('/_hasChanges', user, project, data, environmentName, null, 'GET');
}

function getAssets(project, user, filter, environmentName) {
    return authContainerAPI('/_assets', user, project, filter, environmentName, null, 'GET');
}

function uploadAsset(project, user, url, filename, environmentName) {
    return authContainerAPI('/_assets', user, project, { url, filename }, environmentName, null, 'POST');
}

function pull(project, user, environmentName) {
    return authContainerAPI('/_pull', user, project, {}, environmentName, null, 'POST');
}

function health(project, user, environmentName, shouldWarmup) {
    return authContainerAPI('/_health' + (shouldWarmup ? '?warmup=1' : ''), user, project, {}, environmentName, null, 'GET');
}

function refresh(project, user, environmentName) {
    return authContainerAPI('/_refresh', user, project, {}, environmentName, null, 'POST');
}

function refreshSchema(project, user, environmentName) {
    return authContainerAPI('/_refresh?schema=1', user, project, {}, environmentName, null, 'POST');
}

function reloadConfig(project, user, environmentName) {
    return authContainerAPI('/_reloadConfig', user, project, {}, environmentName, null, 'POST');
}

function fastWrite(project, user, data, originPath) {
    const hasFastWrite = _.get(project, 'deploymentData.container.hasFastWrite', false);

    return hasFastWrite ? authContainerAPI('/_fastWrite', user, project, {
        pageUrl: originPath,
        fields: data
    }) : Promise.resolve({});
}

function getBranchStatus(project, user, environmentName) {
    return authContainerAPI('/_branchStatus', user, project, {}, environmentName, null, 'GET', 'application/json');
}

function canPublish(project, user, environmentName) {
    return authContainerAPI('/_canPublish', user, project, {}, environmentName, null, 'GET', 'application/json');
}

function updateStackbitSchema(project, user, data, environmentName) {
    return authContainerAPI('/_schemaEditor/config', user, project, data, environmentName, null, 'PUT', 'application/json');
}

function generateStackbitSchema(project, user, environmentName) {
    return authContainerAPI('/_schemaEditor/config/generate', user, project, {}, environmentName, null, 'POST', 'application/json');
}

function getSiteConfig(project, user, environmentName) {
    return authContainerAPI('/_siteConfig', user, project, {}, environmentName, null, 'GET', 'application/json');
}

function updateSiteConfig(project, user, environmentName, data) {
    return authContainerAPI('/_siteConfig', user, project, data, environmentName, null, 'PATCH', 'application/json');
}

module.exports = {
    publish,
    renameSite,
    deleteSite,
    getSiteUrl,
    getSitePreviewUrl,
    getObject,
    createObject,
    updateObject,
    publishDrafts,
    hasChanges,
    getAssets,
    uploadAsset,
    fastWrite,
    pull,
    health,
    refresh,
    refreshSchema,
    reloadConfig,
    getBranchStatus,
    canPublish,
    deleteObject,
    updateStackbitSchema,
    generateStackbitSchema,
    getSiteConfig,
    updateSiteConfig
};
