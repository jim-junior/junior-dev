const _ = require('lodash');
const path = require('path');
const gitP = require('simple-git/promise');
const fse = require('fs-extra');
const mime = require('mime');

const forestryService = require('../../forestry-services/forestry-service');
const Project = require('../../../models/project.model').default;
const logger = require('../../logger');
const config = require('../../../config').default;
const githubService = require('../../github-services/github-repo');
const analytics = require('../../analytics/analytics');
const gitbasedCms = require('./gitbased');
const fileUtils = require('../../utils/file-utils');
const refresh = require('passport-oauth2-refresh');

class ForestryCms extends gitbasedCms.GitBasedCms {

    contextForBuild(project, user, buildLogger) {
        const cmdArgs = [];
        let webhookHostname = config.server.webhookHostname;
        const forestryWebhookURL = `${webhookHostname}/project/${project.id}/webhook/forestry`;
        cmdArgs.push('--forestry-webhook-url=' + forestryWebhookURL);
        return cmdArgs;
    }

    preBuild(project, user, previewBranchName, buildLogger) {
        return Project.updateDeploymentData(project._id, 'forestry', {
            branch: previewBranchName
        });
    }

    preDeploy(project, user, buildLogger) {
        if (!config.forestry.apiEnabled) {
            return Project.updateDeploymentData(project._id, 'forestry', {
                connected: true
            });
        }

        const token = getToken(user);

        buildLogger.debug('Forestry: importing site from github repo');
        return githubService.getGithubUser(user.githubAccessToken).then((githubUser) => {
            let githubAccessToken = user.githubAccessToken;
            if (_.get(project, 'wizard.repository.settings.sharedUser')) {
                githubAccessToken = config.container.shared.githubAccessToken;
            }
            const branch = project.getDeploymentData('forestry.branch', null, project.getDefaultBranch());
            return forestryService.importSite(project, githubUser, githubAccessToken, token, branch).then(site => {
                buildLogger.debug('Forestry: github site imported', {forestrySiteId: site.lookup});

                forestryService.updateChecklist(project, token);

                return Project.updateDeploymentData(project._id, 'forestry', {
                    connected: true,
                    siteId: site.lookup,
                    url: `https://app.forestry.io/sites/${site.lookup}/`
                });
            });
        }).catch(err => {
            buildLogger.error('Forestry: Error: failed to import github site', {error: err});
            throw err;
        });
    }

    onWebhook(project, user, req) {
        const body = req.body;
        if (body.event === 'post_import' && body.success === true) {    // forestry import
            const forestrySiteId = _.get(body, 'id', null);
            return Project.forestryImported(project.id, forestrySiteId).then(project => {
                analytics.track('Project Forestry Imported', {projectId: project.id, userId: user.id}, user);
            });
        } else if (body.event === 'post_import' && body.success === false) {
            return Project.updateDeploymentData(project.id, 'forestry', {
                connected: false,
                error: body.error
            }).then(project => {
                Project.updateBuildStatus(project._id, 'build-failed', {message: `Forestry error: ${body.error}`});
                analytics.track('Forestry: import failed', {
                    projectId: project.id,
                    userId: user.id,
                    error: body.error
                }, user);
            });
        } else if (body.event === 'post_publish' && body.success === true) {
            return Project.updateDeploymentData(project.id, 'forestry', {publishedAt: new Date()});
        }

        return Promise.resolve(project);
    }

    envForContainer(project, user, environmentName) {
        return {
            CMS_TYPE: _.get(project, 'wizard.cms.id'),
            FORESTRY: {
                siteId: project.getDeploymentData('forestry.siteId', environmentName)
            }
        };
    }

    async preProvision(project, user) {
        const projectDir = _.get(project, 'deploymentData.build.outputDir');
        const forestryWebhookURL = `${config.server.webhookHostname}/project/${project.id}/webhook/forestry`;
        const forestrySettingsPath = path.join(projectDir, '.forestry/settings.yml');

        const hasRepo = await fse.exists(path.join(projectDir, '.git'));
        const simpleRepo = hasRepo ? gitP(projectDir) : null;

        return fileUtils.patchFile(forestrySettingsPath, {
            '__FORESTRY_WEBHOOK_URL__': forestryWebhookURL
        }).then(() => {
            if (simpleRepo) {
                return simpleRepo.add(forestrySettingsPath);
            }
        }).then(() => project);
    }

    provision(project, user, draftsReadyCallback, progressCallback) {
        if (draftsReadyCallback) {
            return draftsReadyCallback(project);
        }
        return Promise.resolve(project);
    }

    getMediaProvider(project, user) {
        return makeForestryCall('getMediaProviders', { project, user })
            .then(response => {
                return response.kind === 'git'; // upload using container, much faster in case of git media provider
            })
            .catch(err => {
                // not fail, entire request, maybe something else happened and image would still upload
                logger.error('Forestry: Get media providers failed', err);
                return false;
            });
    }

    async updatePage(project, user, { changedFields, ...data }) {
        const hasUploadAsset = changedFields.find(field => _.get(field, 'uploadAsset.url'));
        let useContainerUpload = false;

        if (hasUploadAsset) {
            useContainerUpload = await this.getMediaProvider(project, user);
        }

        return Promise.all(
            changedFields.map(field => {
                const { uploadAsset } = field;
                if (uploadAsset && uploadAsset.url) {
                    logger.debug('Forestry: Uploading asset');
                    const fileName = _.get(uploadAsset, 'metadata.name');
                    return this.uploadAsset({
                        useGitProvider: useContainerUpload,
                        url: uploadAsset.url,
                        fileName,
                        project,
                        user
                    })
                        .then(response => {
                            field = _.omit(field, ['uploadAsset']);
                            field.linkAsset = { id: response.objectId };
                            return field;
                        });
                }
                return field;
            })
        ).then(changedFields => {
            return super.updatePage(project, user, { changedFields, ...data });
        });
    }

    uploadAsset({ project, user, url, fileName, useGitProvider = false }) {
        return useGitProvider
            ? super.uploadAsset({ project, user, url, fileName })
                .catch(err => {
                    if (_.get(err, 'error') === 'Error: Unsupported Operation') { // for old container
                        return makeForestryCall('uploadAsset', { project, user }, url, fileName);
                    }
                    throw err;
                })
            : makeForestryCall('uploadAsset', { project, user }, url, fileName);
    }

    async getAssets(project, user, filter) {
        const assetsType = 'image'; // right now hardcoded for images only, might be also other types in future
        const SEPARATOR = '$$';

        const pageSize = _.get(filter, 'pageSize', 20);
        let pageId = _.get(filter, 'pageId') || '';
        const pageIdParts = pageId.split(SEPARATOR);

        let lastItemId;
        if (pageIdParts.length > 1) {
            [lastItemId, pageId] = pageIdParts;
        }

        const assets = [];
        let lastAssetId;

        while ((assets.length < pageSize) && pageId !== null) {
            const { nextPage, data } = await loadAssets(project, user, assetsType, { ...filter, pageId });
            const startIndex = lastItemId ? data.findIndex(asset => asset.id === lastItemId) + 1 : 0;

            for (let i = startIndex; i < data.length; i++) {
                const asset = data[i];
                assets.push(asset);
                if (assets.length === pageSize && i !== (data.length - 1)) {
                    lastAssetId = asset.id;
                    break;
                }
            }

            lastItemId = null;
            pageId = nextPage;
        }

        let nextPage = [lastAssetId, pageId].filter(Boolean).join(SEPARATOR);
        if (!nextPage) {
            nextPage = null;
        }

        return {
            data: assets,
            meta: {
                nextPage
            }
        };
    }

    async uploadAssets(project, user, { srcEnvironment, assets }) {
        const useContainerUpload = await this.getMediaProvider(project, user);
        const images = await Promise.all(assets.map((uploadAsset) => this.uploadAsset({
            useGitProvider: useContainerUpload,
            url: uploadAsset.url,
            fileName: _.get(uploadAsset, 'metadata.name'),
            project,
            user
        })));
        return images.map((imageResponse) => {
            return {
                objectId: imageResponse.objectId,
                url: imageResponse.thumb512 || imageResponse.url || imageResponse.urlPath,
                fileName: imageResponse.fileName || imageResponse.filename,
                createdAt: imageResponse.createdAt
            };
        });
    }

    fillObject({ model, schema, parentField, cmsId, values }) {
        const object = super.fillObject({ model, schema, parentField, cmsId, values });
        // DEPRECATION NOTICE: parentField.type === 'models' is deprecated and can be removed after release of V2
        if (parentField && (parentField.type === 'models' || parentField.type === 'model')) {
            object.template = model.name;
        }
        return object;
    }

    refreshToken(user) {
        let forestryConnection;
        try {
            forestryConnection = getConnection(user);
        } catch (err) {
            logger.debug('Forestry: No forestry connection to refresh', { userId: user.id });
            return Promise.reject({ code: 404, message: 'Connection not found' });
        }

        return new Promise((resolve, reject) => {
            refresh.requestNewAccessToken('forestry', forestryConnection.refreshToken, function (err, accessToken, refreshToken) {
                if (err) {
                    return user.removeConnection('forestry').then(() => {
                        logger.debug('Forestry: removed access token, cannot refresh', { userId: user.id });
                        reject({ code: 500, error: err });
                    });
                }
                return user.addConnection('forestry', { accessToken, refreshToken }).then(() => {
                    logger.debug('Forestry: Access token refreshed', { userId: user.id });
                    resolve();
                });
            });
        });
    }
}

const forestryCms = new ForestryCms();
module.exports = forestryCms;

function getConnection(user) {
    const forestryConnection = _.find(user.connections, {type: 'forestry'});
    if (!forestryConnection) {
        throw new Error('Forestry: Access token missing for creation');
    }
    return forestryConnection;
}

function getToken(user) {
    return getConnection(user).accessToken;
}

function makeForestryCall(methodName, { project, user, refresh = true }, ...args) {
    const token = getToken(user);

    return Promise.resolve()
        .then(() => forestryService[methodName](project, user, ...args, token))
        .catch(err => {
            if (refresh && err.code === 401 && err.message === forestryService.FAILED_TO_LOGIN) {
                return forestryCms.refreshToken(user)
                    .then(() => makeForestryCall(methodName, { project, user, refresh: false }, ...args) );
            }
            throw err;
        });
}

function loadAssets(project, user, assetsType, filter) {
    return makeForestryCall('listAssets', { project, user }, filter)
        .then(response => {
            const data = _.flatMap(response.contents, image => {
                if (assetsType !== 'all') {
                    const fileType = mime.getType(image.filename);
                    const [assetType] = _.split(fileType, '/');
                    if (assetType !== assetsType) {
                        return [];
                    }
                }

                return {
                    objectId: image.servedFromFrontMatter,
                    id: image.id,
                    url: image.thumb512 || image.url,
                    fileName: image.filename,
                };
            });

            return {
                data,
                nextPage: response.nextCursor
            };
        });
}
