const _ = require('lodash');
const path = require('path');
const config = require('../../../config').default;
const logger = require('../../logger');
const containerService = require('../container-service');
const gitService = require('../git-service');
const Project = require('../../../models/project.model').default;
const { getDefaultFieldsFromModel, convertValueToType, generateNameId, interpolatePath, sanitizeSlug } = require('../../utils/cms.utils');
const { compareBranches } = require('../../github-services/github-repo');
const { response } = require('express');

class GitBasedCms {

    envForContainer(project, user, environmentName) {
        return {
            CMS_TYPE: _.get(project, 'wizard.cms.id')
        };
    }

    provision(project, user, draftsReadyCallback, progressCallback) {
        if (draftsReadyCallback) {
            return draftsReadyCallback(project);
        }
        return Promise.resolve(project);
    }

    importExisting(project, user, previewBranch, publishBranch, buildLogger) {
        const cmsId = _.get(project, 'wizard.cms.id');
        return Project.updateDeploymentData(project._id, cmsId, {
            connected: true,
            branch: previewBranch
        });
    }

    provisionEnvironments(project, user, environments) {
        const url = _.get(project, 'deploymentData.github.sshURL');
        const privateKey = _.get(project, 'deploymentData.container.deployPrivateKey');
        const publicKey = _.get(project, 'deploymentData.container.deployPublicKey');
        const { previewBranch } = project.getContainerBranches();
        const branches = environments.map(environmentName => `preview-${environmentName}`);
        return gitService.createBranches(url, privateKey, publicKey, previewBranch, branches).then(() => {
            return Promise.all(
                branches.map((branch, i) => {
                    return Project.updateDeploymentData(project.id,  _.get(project, 'wizard.cms.id'), {
                        branch
                    }, environments[i]);
                })
            );
        }).then(results => results[0]);
    }

    migrateToEnvironment(project, user, environmentName, tag) {
        if (!_.get(project, `environments.${environmentName}`)) {
            return Promise.resolve(project);
        }
        logger.debug('GitBased: migrateToEnvironment', {projectId: project.id});
        const url = _.get(project, 'deploymentData.github.sshURL');
        const privateKey = _.get(project, 'deploymentData.container.deployPrivateKey');
        const publicKey = _.get(project, 'deploymentData.container.deployPublicKey');
        let allBranches = Object.keys(project.environments).concat(null).map(environmentName => {
            return project.getDeploymentData('container.previewBranch', environmentName);
        });
        const envPreviewBranch = project.getDeploymentData('container.previewBranch', environmentName);
        const primaryPreviewBranch = project.getDeploymentData('container.previewBranch');
        return gitService.tagBranches(url, privateKey, publicKey, allBranches, tag).then(() => {
            logger.debug('GitBased: changing branch pointer', {projectId: project.id});
            return gitService.updateBranchToAnother(url, privateKey, publicKey, envPreviewBranch, primaryPreviewBranch);
        }).then(() => {
            return containerService.pull(project, user).catch(err => {
                logger.debug('GitBased: error pulling container', {projectId: project.id, err});
            });
        }).then(() => project);
    }

    removeEnvironments(project, user, environments) {
        logger.debug('GitBased: removing environments', {projectId: project.id, environments});
        const cmsId = _.get(project, 'wizard.cms.id');
        const url = _.get(project, 'deploymentData.github.sshURL');
        const privateKey = _.get(project, 'deploymentData.container.deployPrivateKey');
        const publicKey = _.get(project, 'deploymentData.container.deployPublicKey');
        const branches = environments.map(environmentName => project.getDeploymentData('container.previewBranch', environmentName));
        return gitService.removeBranches(url, privateKey, publicKey, branches).then(() => project);
    }

    createPage(project, user, { modelName, schema, srcProjectId, srcEnvironment, fields, pageModel }) {
        const userSlugFieldName = pageModel.slugField || '_stackbit_slug';
        const userSlug = _.get(fields, userSlugFieldName);
        const otherFields = _.omit(fields, userSlugFieldName);
        const model = _.find(schema, { name: modelName });
        const cmsId = _.get(project, 'wizard.cms.id', 'git');
        const environmentName = getEnvironmentNameFromBranch(project, srcEnvironment);

        if (!model || !userSlug || !pageModel.filePath) {
            throw new Error('Model should be defined, slug is provided and pageModel should contains filePath attribute');
        }

        const data = this.createObject(userSlug, otherFields, { model, pageModel, schema, cmsId });

        logger.debug('GitBased: create page', { srcProjectId: srcProjectId, projectId: project.id, userId: user.id, modelName, filePath: data.filePath });

        return containerService.createObject(project, user, data, environmentName)
            .then(object => {
                logger.debug(`GitBased: Object ${_.get(object, 'id')} created.`);
                return object;
            })
            .catch(err => {
                logger.error('GitBased: Failed to create an object', {
                    error: err,
                    projectId: project.id,
                    userId: user.id
                });
                throw err;
            });
    }

    duplicatePage(project, user, { pageId, srcProjectId, srcEnvironment, fields, schema, pageModel }) {
        const userSlugFieldName = pageModel.slugField || '_stackbit_slug';
        const userSlug = _.get(fields, userSlugFieldName);
        const otherFields = _.omit(fields, userSlugFieldName);
        const cmsId = _.get(project, 'wizard.cms.id', 'git');
        const environmentName = getEnvironmentNameFromBranch(project, srcEnvironment);

        if (!userSlug) {
            throw new Error('Slug field not defined');
        }

        return containerService.getObject(project, user, { projectId: srcProjectId, objectId: pageId }, environmentName)
            .then(object => {
                if (!object) {
                    throw new Error('Object not found');
                }

                const modelName = pageModel.modelName;
                const model = _.find(schema, { name: modelName });
                const data = this.createObject(userSlug, { ...object, ...otherFields, ...pageModel.fields }, { model, pageModel, schema, cmsId });
                return containerService.createObject(project, user, data, environmentName);
            })
            .then(object => {
                logger.debug(`GitBased: Object ${object.id} duplicated from ${pageId}.`);
                return object;
            })
            .catch(err => {
                logger.error('GitBased: Failed to duplicate an object', {
                    error: err,
                    projectId: project.id,
                    userId: user.id
                });
                throw err;
            });
    }

    updatePage(project, user, { changedFields, schema }) {
        const fieldsByEntity = _.groupBy(changedFields, 'srcObjectId');
        return Promise.all(
            Object.keys(fieldsByEntity).map(srcObjectId => {
                const fields = fieldsByEntity[srcObjectId];
                const { srcProjectId, srcEnvironment, srcType } = fields[0];
                const environmentName = getEnvironmentNameFromBranch(project, srcEnvironment);
                const cmsSchema = schema[srcType][srcProjectId];

                logger.debug('GitBased: update page for object in project', { projectId: project.id, userId: user.id, srcProjectId, srcObjectId, environmentName });

                return containerService.getObject(project, user, { projectId: srcProjectId, objectId: srcObjectId }, environmentName)
                    .then(async (object) => {
                        for (const field of fields) {
                            object = await this.modifyItem({ project, user, object, field, schema: cmsSchema });
                        }
                        return object;
                    })
                    .then(object => {
                        return containerService.updateObject(project, user, {
                            projectId: srcProjectId,
                            objectId: srcObjectId,
                            object
                        }, environmentName);
                    })
                    .then(object => {
                        logger.debug(`GitBased: Object ${_.get(object, 'id')} updated.`);
                        return object;
                    })
                    .catch(err => {
                        logger.error('GitBased: Failed to update an object', {
                            error: err.toString(),
                            stack: err.stack,
                            projectId: project.id,
                            userId: user.id
                        });
                        throw err;
                    });
            })
        );
    }

    publishDrafts(project, user, data, environmentName, buildLogger) {
        return containerService.publishDrafts(
            project,
            user,
            data,
            environmentName || getEnvironmentNameFromBranch(project, _.get(data, 'objects.[0].srcEnvironment')),
            buildLogger
        );
    }

    hasAccess(project, user) {
        return {
            hasConnection: true,
            hasPermissions: true
        };
    }

    pull(project, user, branch) {
        const environmentName = getEnvironmentNameFromBranch(project, branch);
        return containerService.pull(project, user, environmentName);
    }

    async hasChanges(project, user, { objects, type = 'objects' }, environmentName) {
        const environment = environmentName || getEnvironmentNameFromBranch(project, _.get(objects, '[0].srcEnvironment'));
        return containerService.hasChanges(project, user, { objects, type }, environment).catch(async err => {
            logger.warn('Error getting branch status from container, requesting from github', {
                err,
                projectId: project.id
            });
            let { githubAccessToken } = user;
            if (_.get(project, 'wizard.repository.settings.sharedUser')) {
                githubAccessToken = config.container.shared.githubAccessToken;
            }
            const { previewBranch, publishBranch } = project.getContainerBranches(environmentName);
            const diff = await compareBranches({
                token: githubAccessToken,
                project,
                base: publishBranch,
                head: previewBranch
            });
            return {
                hasChanges: diff.ahead > 0,
                changedObjects: []
            };
        });
    }

    getAssets(project, user, filter) {
        const { srcEnvironment } = filter;
        const pageId = filter.pageId || 1;
        const environmentName = getEnvironmentNameFromBranch(project, srcEnvironment);
        return containerService.getAssets(project, user, filter, environmentName)
            .then(response => {
                return {
                    data: response.assets,
                    meta: {
                        nextPage: pageId < response.meta.totalPages ? pageId + 1 : null
                    }
                };
            });
    }

    modifyItem({ object, field, schema, project, user }) {
        const cmsId = _.get(project, 'wizard.cms.id', 'git');
        const environmentName = getEnvironmentNameFromBranch(project, _.get(field, 'srcEnvironment'));
        const { order, add, remove, value, fieldPath, linkAsset, uploadAsset, setObject } = field;
        const fieldModel = getFieldModelAtFieldPath({
            object,
            model: schema[object.__metadata.srcModelName],
            modelsByName: schema,
            fieldPath: fieldPath
        });

        if (order || add || (remove && fieldModel.type === 'list')) {
            return this.modifyList({ object, fieldModel, fieldPath, field, schema, project, user });
        } else if (remove) {
            _.unset(object, fieldPath);
        } else if (linkAsset) {
            if (linkAsset.id) {
                _.set(object, fieldPath, linkAsset.id);
            } else {
                _.unset(object, fieldPath);
            }
        } else if (uploadAsset && uploadAsset.url) {
            return this.uploadAsset({
                url: uploadAsset.url,
                fileName: uploadAsset.metadata?.name,
                project,
                user,
                environmentName
            })
                .then(response => {
                    const newField = _.omit(field, ['uploadAsset']);
                    newField.linkAsset = { id: response.objectId };
                    return this.modifyItem({
                        object,
                        schema,
                        project,
                        user,
                        field: newField
                    });
                });
        } else if (setObject) {
            const { values } = setObject;
            const { selectedObjectId, selectedModelName } = setObject;
            if (fieldModel.type === 'reference') {
                let objectPromise;
                if (selectedObjectId) {
                    objectPromise = Promise.resolve({ id: selectedObjectId });
                } else {
                    const data = this.createObjectForReferenceField({
                        referenceField: fieldModel,
                        modelName: selectedModelName,
                        schema,
                        cmsId
                    });
                    objectPromise = containerService.createObject(project, user, data, environmentName);
                }
                return objectPromise.then(selectedObject => {
                    _.set(object, fieldPath, selectedObject.id);
                    return object;
                }).catch(err => {
                    logger.error('GitBased: Failed to create an object', {
                        error: err.toString(),
                        stack: err.stack,
                        projectId: project.id,
                        userId: user.id
                    });
                    throw err;
                });
            } else {
                let model = fieldModel;
                if (selectedModelName) {
                    model = schema[selectedModelName];
                }
                const newObj = this.fillObject({
                    parentField: fieldModel,
                    model,
                    schema,
                    cmsId,
                    values,
                });
                _.set(object, fieldPath, newObj);
            }
        } else if (_.isNil(value) || value === '') {
            _.unset(object, fieldPath);
        } else {
            const adjustedValue = convertValueToType(value, fieldModel.type);
            _.set(object, fieldPath, adjustedValue);
        }

        return Promise.resolve(object);
    }

    uploadAsset({ project, user, url, fileName, environmentName }) {
        return containerService.uploadAsset(project, user, url, fileName, environmentName);
    }

    async uploadAssets(project, user, { srcEnvironment, assets }) {
        const environmentName = getEnvironmentNameFromBranch(project, srcEnvironment);
        return Promise.all(assets.map((uploadAsset) => this.uploadAsset({
            fileName: _.get(uploadAsset, 'metadata.name'),
            url: uploadAsset.url,
            project,
            user,
            environmentName,
        })));
    }

    modifyList({ object, fieldModel, fieldPath, field, schema, project, user}) {
        const cmsId = _.get(project, 'wizard.cms.id', 'git');
        const environmentName = getEnvironmentNameFromBranch(project, _.get(field, 'srcEnvironment'));
        const { order, add, remove } = field;
        if (!_.has(object, fieldPath)) {
            _.set(object, fieldPath, []);
        }
        const arr = _.get(object, fieldPath);
        if (order) {
            const entryArr = arr.slice();
            const newEntryArr = order.map(newIndex => entryArr[newIndex]);
            _.set(object, fieldPath, newEntryArr);
            return Promise.resolve(object);
        } else if (add) {
            const { selectedModelName, selectedObjectId, values, position = arr.length } = field.add;
            if (selectedObjectId) {
                arr.splice(position, 0, selectedObjectId);
                return Promise.resolve(object);
            } else {
                const { model, listItemsField } = getListItemsFieldAndModelForNewListItem({fieldModel, selectedModelName, schema});
                if (listItemsField.type === 'reference') {
                    const data = this.createObjectForReferenceField({
                        referenceField: listItemsField,
                        modelName: selectedModelName,
                        schema,
                        cmsId
                    });
                    return containerService.createObject(project, user, data, environmentName).then(newObject => {
                        logger.debug(`GitBased: Object ${_.get(newObject, 'id')} created.`);
                        arr.splice(position, 0, newObject.id);
                        return object;
                    }).catch(err => {
                        logger.error('GitBased: Failed to create an object', {
                            error: err,
                            projectId: project.id,
                            userId: user.id
                        });
                        throw err;
                    });
                } else {
                    const value = this.fillObject({ parentField: listItemsField, model, schema, cmsId, values });
                    arr.splice(position, 0, value);
                    return Promise.resolve(object);
                }

            }
        } else if (remove) {
            const { index } = remove;
            if (typeof index === 'number') {
                arr.splice(index, 1);
            }
            _.set(object, fieldPath, arr);
            return Promise.resolve(object);
        }
    }

    createObjectForReferenceField({ referenceField, modelName, schema, cmsId }) {
        const { dirPath, fileExt } = referenceField;
        const model = _.get(schema, modelName);
        const fileName = generateNameId(modelName);
        const pageModel = {
            slugField: 'slug',
            filePath: path.join(dirPath, `%slug%.${fileExt}`)
        };
        return this.createObject(fileName, {}, { model, pageModel, schema, parentField: referenceField, cmsId });
    }

    createObject(userSlug, object, { model, pageModel, schema, parentField, cmsId }) {
        // slug can be 'some-page' but also might be '2020/some-page' where 2020 is a 'parent' folder
        let slug = sanitizeSlug(userSlug);
        if (slug.endsWith('/')) {
            slug += 'index';
        }
        const slugField = _.get(pageModel, 'slugField', 'slug');
        const filePathTemplate = _.get(pageModel, 'filePath');
        const instanceFields = this.fillObject({ model, schema, parentField, cmsId, values: object });
        if (_.has(instanceFields, slugField)) {
            instanceFields[slugField] = slug;
        }
        const context = Object.assign({}, instanceFields, { [slugField]: slug });
        const interpolatedFields = interpolateObjectFieldsWithContext(instanceFields, context);
        const filePath = interpolatePath(filePathTemplate, context);

        return {
            object: interpolatedFields,
            modelName: model.name,
            filePath
        };
    }

    fillObject({ model, schema, parentField, cmsId, values }) {
        const defaultValue = getDefaultFieldsFromModel(model, schema, 2);
        const object = typeof defaultValue === 'object' ? {
            ...defaultValue,
            ...values
        } : defaultValue;
        // if parentField is of type 'model', add 'type' field if the field has more than one model in 'models' array
        /// DEPRECATION NOTICE: parentField.type === 'models' is deprecated and can be removed after release of V2
        const hasMultipleModels = parentField?.type === 'model' && parentField.models && parentField.models.length > 1;
        if ((parentField?.type === 'models' || hasMultipleModels) && cmsId === 'git') {
            // TODO: change 'type' to the value of objectTypeKey from stackbit.yaml, or move this logic to container
            object.type = model.name;
        }
        return object;
    }

    deleteObject(project, user, { srcEnvironment, srcObjectId, srcProjectId }) {
        const environmentName = getEnvironmentNameFromBranch(project, srcEnvironment);

        logger.debug('GitBased: delete object', { srcObjectId, srcProjectId: srcProjectId, projectId: project.id, userId: user.id });

        return containerService.deleteObject(project, user, {
            projectId: srcProjectId,
            objectId: srcObjectId
        }, environmentName).catch(err => {
            logger.error('GitBased: Failed to delete an object', {
                error: err,
                projectId: project.id,
                userId: user.id
            });

            throw err;
        });
    }
}

module.exports = new GitBasedCms();
module.exports.GitBasedCms = GitBasedCms;

function getEnvironmentNameFromBranch(project, srcEnvironment) {
    return _.first(Object.keys(_.get(project, 'environments', {})).map(environmentId => {
        if (_.get(project, `environments.${environmentId}.container.previewBranch`) === srcEnvironment) {
            return environmentId;
        }
        return null;
    }).filter(Boolean));
}

/**
 * Old projects like perimeterX have tokens (e.g.: %slug%) encoded right into the pageModels.fields
 * This function replaces these tokens with user provided param
 */
function interpolateObjectFieldsWithContext(field, context) {
    if (typeof field === 'string') {
        return field.replace(/%(.*?)%/g, (match, p) => _.get(context, p));
    } else if (Array.isArray(field)) {
        return field.map(value => interpolateObjectFieldsWithContext(value, context));
    } else if (_.isObject(field)) {
        return _.mapValues(field, value => interpolateObjectFieldsWithContext(value, context));
    } else {
        return field;
    }
}

function getFieldModelAtFieldPath({ object, fieldPath, model, modelsByName }) {
    if (_.isEmpty(fieldPath)) {
        return model;
    }

    const fieldName = _.head(fieldPath);
    const fieldPathTail = _.tail(fieldPath);

    const modelType = model.type;
    if (['object', 'page', 'data'].includes(modelType)) {
        return getFieldModelAtFieldPath({
            object: object[fieldName],
            fieldPath: fieldPathTail,
            model: _.find(model.fields, { name: fieldName }),
            modelsByName
        });
    } else if (modelType === 'model' || modelType === 'models') {
        // DEPRECATION NOTICE: modelType === 'models' is deprecated, can be removed after release of V2
        const modelName = _.get(object, '__metadata.srcModelName');
        let childModel = _.get(modelsByName, modelName);
        return getFieldModelAtFieldPath({
            object: object,
            fieldPath: fieldPath,
            model: childModel,
            modelsByName
        });
    } else if (modelType === 'reference') {
        // "reference" type can not appear in fieldPath
    } else if (modelType === 'list') {
        let itemModel;
        const item = object[fieldName];
        if (_.isArray(model.items)) {
            // in NetlifyCMS the type key is stored in 'model.typeKey', default is 'type'
            // in git-cms, the type key is always type
            const typeKey = _.get(model, 'typeKey', 'type');
            const objectType = _.get(item, typeKey);
            itemModel = _.find(model.items, {name: objectType});
        } else {
            itemModel = model.items;
        }
        return getFieldModelAtFieldPath({
            object: item,
            fieldPath: fieldPathTail,
            model: itemModel,
            modelsByName
        });
    }
}

function getListItemsFieldAndModelForNewListItem({ fieldModel, selectedModelName, schema }) {
    let itemModel = fieldModel.items;

    if (Array.isArray(itemModel)) {
        if (!selectedModelName) {
            throw new Error('Adding an item to array with multiple item types require passing selectedModelName');
        }
        itemModel = _.find(itemModel, _itemModel => {
            if (_itemModel.type === 'reference') {
                return _.includes(_itemModel.models, selectedModelName);
            }
            // DEPRECATION NOTICE: itemModel.type === 'models' is deprecated and can be removed after release of V2
            if (_itemModel.type === 'models') {
                return _.includes(_itemModel.models, selectedModelName);
            }
            if (_itemModel.type === 'model') {
                // DEPRECATION NOTICE: itemModel.model of itemModel.type === 'model' is deprecated and can be removed after release of V2
                return _itemModel.model ? _itemModel.model === selectedModelName : _.includes(_itemModel.models, selectedModelName);
            }
            if (_itemModel.type === 'object') {
                return _itemModel.name === selectedModelName;
            }
        });
        if (!itemModel) {
            throw new Error(`Could not resolve model for new list item for selectedModelName ${selectedModelName}`);
        }
    }

    const itemType = itemModel.type;

    if (itemType === 'reference') {
        const modelName = selectedModelName || _.get(itemModel, 'models.0');
        return {
            listItemsField: itemModel,
            model: schema[modelName]
        };
    } else if (itemType === 'models') {
        // DEPRECATION NOTICE: itemType === 'models' is deprecated and can be removed after release of V2
        const modelName = selectedModelName || _.get(itemModel, 'models.0');
        return {
            listItemsField: itemModel,
            model: schema[modelName]
        };
    } else if (itemType === 'model') {
        let model;
        // DEPRECATION NOTICE: itemModel.model of itemType === 'model' is deprecated, can be removed after release of V2
        if (itemModel.model) {
            model = schema[itemModel.model];
        } else {
            const modelName = selectedModelName || _.get(itemModel, 'models.0');
            model = schema[modelName];
        }
        return {
            listItemsField: itemModel,
            model: model
        };
    } else if (itemType === 'object') {
        return {
            listItemsField: itemModel,
            model: itemModel
        };
    } else {
        return {
            listItemsField: itemModel,
            model: itemModel
        };
    }
}
