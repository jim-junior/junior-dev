const aws = require('aws-sdk');
const _ = require('lodash');
const logger = require('../logger');
const analytics = require('../../services/analytics/analytics');
const User = require('../../models/user.model').default;
const Project = require('../../models/project.model').default;
const {publish, deleteSite} = require('../deploy-services/container-service');
const config = require('../../config').default;
const ResponseErrors = require('../../routers/response-errors');
const ProjectBuildService = require('../deploy-services/project-build-service');
const crypto = require('crypto');

const DATA_BUCKET_NAME = 'stackbit-jobox-data';
const CONTAINER_BUCKET_NAME = 'jobox-container';

function uploadPage(projectId, data, headers) {
    return Promise.all([
        s3Upload(`${projectId}/data.json`, JSON.stringify(data, null, 4)),
        s3Upload(`${projectId}/headers.json`, JSON.stringify(headers, null, 4))
    ]);
}

function s3Upload(key, data) {
    const s3 = new aws.S3();
    const params = {
        Bucket: DATA_BUCKET_NAME,
        Key: key,
        Body: data,
        ACL: 'public-read',
        ContentType: 'application/json'
    };
    return s3.upload(params).promise()
        .then((data) => {
            logger.debug('Uploaded ' + key);
            return data;
        });
}

function s3Download(key) {
    const s3 = new aws.S3();
    const params = {
        Bucket: DATA_BUCKET_NAME,
        Key: key,
    };
    return s3.getObject(params).promise()
        .then((data) => {
            logger.debug('Downloaded ' + key);
            return JSON.parse(data.Body.toString());
        });
}

function create(joboxId, req) {
    return User.findById(config.jobox.userId).then(joboxUser => {
        if (!joboxUser) {
            logger.error('Jobox user not found!', config.jobox.userId);
            throw 'Jobox user not found';
        }

        return Project.findProjectByContainerName(joboxId).then(project => {
            if (project) {
                throw ResponseErrors.ContainerProjectAlreadyExists;
            }

            return Project.createProject({
                wizard: {
                    deployment: {
                        id: 'container'
                    }
                },
                importData: {
                    dataType: 'jobox',
                    settings: {joboxId: joboxId}
                },
                deploymentData: {
                    container: {
                        name: joboxId,
                        bucket: CONTAINER_BUCKET_NAME,
                        fastlySpaceId: '5mNGlAeph8MuMWBgVvYVNw',
                        internalUrl: config.jobox.internalUrl,
                        adminToken: crypto.randomBytes(32).toString('hex')
                    }
                },
                siteUrl: `https://bc.getjobox.com/${joboxId}/`
            }, joboxUser).then(project => {
                analytics.track('API Project Created', {
                    userId: joboxUser.id,
                    projectId: project.id,
                    type: 'jobox',
                    theme: _.get(project, 'wizard.theme.id'),
                    ssg: _.get(project, 'wizard.ssg.id'),
                    cms: _.get(project, 'wizard.cms.id'),
                    deploymentType: _.get(project, 'wizard.deployment.id', null),
                    containerType: _.get(project, 'wizard.container.id'),
                    // backward compatible analytics
                    // remove in future
                    deployment: _.get(project, 'wizard.container.id', _.get(project, 'wizard.deployment.id', null)),
                    settings: _.get(project, 'wizard.settings')
                }, joboxUser);
                return Project.createAPIKeyWithKey(project._id, 'container-key', config.server.joboxContainerSecret);
            });
        }).then(project => {
            return uploadPage(project.id, req.body, req.headers).then(() => {
                return ProjectBuildService.deployProject(project.id, joboxUser);
            });
        }).catch(err => {
            if (err.name === 'ContainerProjectAlreadyExists') {
                logger.debug('Jobox WARN: hit create with an existing joboxId', joboxId, req.body);
                return update(joboxId, req);
            }

            throw err;
        });
    }).catch(err => {
        logger.error('Jobox: Failed to create site', {error: err, joboxId, body: req.body});
        throw err;
    });
}

function update(joboxId, req) {
    return Project.findProjectByContainerName(joboxId).then(project => {
        if (!project) {
            throw ResponseErrors.NotFound;
        }

        return uploadPage(project.id, req.body, req.headers).then(() => {
            return publish(project, false, logger).then(() => project);
        });
    });
}

function joboxPublish(joboxId, req) {
    return Project.findProjectByContainerName(joboxId).then(project => {
        if (!project) {
            throw ResponseErrors.NotFound;
        }

        return publish(project, false, logger).then(() => project);
    });
}

function remove(joboxId) {
    return Project.findProjectByContainerName(joboxId).then(project => {
        if (!project) {
            throw ResponseErrors.NotFound;
        }
        const fastlySpaceId = _.get(project, 'deploymentData.container.fastlySpaceId');
        return deleteSite(project.id, CONTAINER_BUCKET_NAME, fastlySpaceId, logger).then(() => {
            return Project.deleteProject(project.id, project.ownerId);
        });
    });
}

function getData(projectId) {
    return s3Download(`${projectId}/data.json`);
}

function joboxAuthAdmin(req, res, next) {
    // token should match `project.deploymentData.container.lastPreviewId`
    const {joboxId} = req.params;
    const {token} = req.query;
    if (!token) {
        return res.status(403).json({message: 'Invalid credentials'});
    }
    return Project.findProjectByContainerName(joboxId).then(project => {
        if (!project) {
            throw ResponseErrors.NotFound;
        }
        const adminToken = _.get(project, 'deploymentData.container.adminToken');
        if (token === adminToken) {
            return next();
        }
        return res.status(403).json({message: 'Invalid credentials'});
    });
}

function updateToken(projectId) {
    logger.debug('Jobox Updating Token');
    const newToken = crypto.randomBytes(32).toString('hex');
    return Project.update(
        { _id: projectId },
        { $set: { 'deploymentData.container.adminToken': newToken }}
    ).then(() => {
        return newToken;
    });
}

module.exports = {
    create,
    update,
    publish: joboxPublish,
    remove,
    joboxAuthAdmin,
    s3Download,
    uploadPage,
    getData,
    updateToken,
    DATA_BUCKET_NAME
};
