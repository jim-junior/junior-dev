const _ = require('lodash');
const aws = require('aws-sdk');
const uuid = require('uuid/v4');

const cmsTypes = require('../../services/deploy-services/cmss');
const config = require('../../config').default;
const containerService = require('../../services/deploy-services/container-service');
const repositoryTypes = require('../../services/deploy-services/repositories');
const logger = require('../logger');
const CollaboratorRole = require('../../models/collaborator-role.model').default;

const editorActions = {
    transferRepo: transferRepoAction,
    createPage: createPageAction,
    deleteObject: deleteObjectAction,
    duplicatePage: duplicatePageAction,
    updatePage: updatePageAction,
    assetUploadStart: assetUploadStartAction,
    uploadAssets: assetsUploadAction,
    getAssets: getAssetsAction,
};

const s3 = new aws.S3({
    useAccelerateEndpoint: true
});

module.exports = {
    makeAction,
    actionPermission: {
        getAssets: CollaboratorRole.Permission.GET_ASSETS,
        uploadAssets: CollaboratorRole.Permission.EDIT_ACCESS,
        assetUploadStart: CollaboratorRole.Permission.EDIT_ACCESS,
        updatePage: CollaboratorRole.Permission.EDIT_ACCESS,
        duplicatePage: CollaboratorRole.Permission.EDIT_ACCESS,
        deleteObject: CollaboratorRole.Permission.EDIT_ACCESS,
        createPage: CollaboratorRole.Permission.EDIT_ACCESS,
        hasCmsAccess: CollaboratorRole.Permission.BASIC_ACCESS,
        transferRepo: CollaboratorRole.Permission.EDIT_ACCESS,
        init: CollaboratorRole.Permission.EDIT_ACCESS
    }
};

function makeAction(action, project, ...args) {
    let promise = Promise.resolve(project);
    const func = _.get(editorActions, action);

    if (!_.isFunction(func)) {
        return promise;
    }

    return promise.then(project => func(project, ...args));
}

function transferRepoAction(project, user) {
    const repoId = _.get(project, 'wizard.repository.id');
    const transferStatus = _.get(project, `deploymentData.${repoId}.transferStatus`);

    if (transferStatus !== 'transferred') {
        logger.info('Calling transfer repo');
        return repositoryTypes.callRepositoryMethodForProject('transferRepo', project, user, logger);
    } else {
        logger.info('Repo is already transferred');
    }

    return Promise.resolve(project);
}

function createPageAction(project, user, data) {
    // todo hardcoded 'homepage' contenttype for chegg should be removed after cmsDeploymentData.url will be normalized due to automatic way
    return cmsTypes.baseInvokeContentSourcesWithProject('createPage', project, user, {
        modelName: data.modelName || 'homepage',
        srcProjectId: data.srcProjectId,
        srcEnvironment: data.srcEnvironment,
        duplicatableModels: data.duplicatableModels,
        fields: data.fields,
        schema: data.schema,
        pageModel: data.pageModel,
        locales: data.locales,
        params: data.params
    });
}

function deleteObjectAction(project, user, data = {}) {
    return cmsTypes.baseInvokeContentSourcesWithProject('deleteObject', project, user, {
        srcEnvironment: data.srcEnvironment,
        srcObjectId: data.srcObjectId,
        srcProjectId: data.srcProjectId
    });
}

function duplicatePageAction(project, user, data = {}) {
    return cmsTypes.baseInvokeContentSourcesWithProject('duplicatePage', project, user, {
        pageId: data.pageId,
        srcProjectId: data.srcProjectId,
        srcEnvironment: data.srcEnvironment,
        duplicatableModels: data.duplicatableModels,
        fields: data.fields,
        schema: data.schema,
        pageModel: data.pageModel,
        locales: data.locales,
        params: data.params
    });
}

function getSignedUrlForAsset(uploadAsset) {
    if (uploadAsset.source === 's3') {
        return s3.getSignedUrl('getObject', {
            Bucket: config.assetUpload.bucket,
            Key: uploadAsset.uri,
            Expires: 5 * 60, // 5 minutes
        });
    }
    return null;
}

function updatePageAction(project, user, { changedFields, schema }, originPath) {
    const changedFieldsWithUploadURLs = changedFields.map(changedField => {
        if (changedField.uploadAsset) {
            const signedUrl = getSignedUrlForAsset(changedField.uploadAsset);
            if (signedUrl) {
                return {
                    ...changedField,
                    uploadAsset: {
                        ...changedField.uploadAsset,
                        url: signedUrl
                    }
                };
            }
        }

        return changedField;
    });

    const addingFields = _.some(changedFieldsWithUploadURLs, field => !_.isEmpty(_.get(field, 'add')));

    // @todo fix fastWrite for adding new items
    if (addingFields) {
        return cmsTypes.baseInvokeContentSourcesWithProject('updatePage', project, user, { changedFields: changedFieldsWithUploadURLs, schema }, originPath);
        //.then(data => containerService.fastWrite(project, user, data, originPath));
    }

    return cmsTypes.baseInvokeContentSourcesWithProject('updatePage', project, user, { changedFields: changedFieldsWithUploadURLs, schema }, originPath).then((data = {}) => {
        return containerService.fastWrite(project, user, changedFields, originPath).then(({didWrite}) => {
            if (didWrite) {
                logger.debug('Update Page with fastWrite');
            }
            return {
                data,
                action: {
                    fastWrite: didWrite
                }
            };
        });
    });
}

function assetUploadStartAction(project, user, data) {
    const key = `${uuid()}/${uuid()}`;
    const parameters = {
        Bucket: config.assetUpload.bucket,
        Fields: {
            key,
            'Content-Type': data.type,
        },
        Expires: 5 * 60, // 5 minutes
        Conditions: [
            ['content-length-range', 1, 20 * 1024 * 1024] // 20MB limit
        ]
    };

    return new Promise((resolve, reject) => {
        s3.createPresignedPost(parameters, (err, data) => {
            if (err) {
                return reject(err);
            }

            const response = {
                url: data.url,
                key: key,
                data: data.fields
            };

            return resolve(response);
        });
    });
}

function assetsUploadAction(project, user, { srcEnvironment, srcProjectId, assets }) {
    const assetsArr = _.chain(assets)
        .castArray()
        .flatMap((asset) => {
            const signedUrl = getSignedUrlForAsset(asset);
            if (signedUrl) {
                asset.url = signedUrl;
                return [asset];
            }
            return [];
        })
        .value();

    return cmsTypes.baseInvokeContentSourcesWithProject('uploadAssets', project, user, { srcEnvironment, srcProjectId, assets: assetsArr });
}

function getAssetsAction(project, user, data) {
    return cmsTypes.baseInvokeContentSourcesWithProject('getAssets', project, user, {
        pageId: data.pageId,
        pageSize: data.pageSize || 20,
        srcProjectId: data.srcProjectId,
        srcEnvironment: data.srcEnvironment,
        searchQuery: data.searchQuery
    });
}
