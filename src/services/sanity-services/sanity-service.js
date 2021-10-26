const _ = require('lodash');
const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const os = require('os');
const uuid = require('uuid');
const sanityClient = require('@sanity/client');
const SanitySchema = require('@sanity/schema').default;
const sanityImport = require('@sanity/import');
const sanityExport = require('@sanity/export');
const { JSDOM } = require('jsdom');
const blockTools = require('@sanity/block-tools');
const { fieldPathToString } = require('@stackbit/utils');
const logger = require('../logger');
const config = require('../../config').default;
const projectUtils = require('../project-services/project-utils').default;
const { getDefaultFieldsFromModel, getFieldDefaultValue, updateSlugField } = require('../utils/cms.utils');
const baseURL = 'https://api.sanity.io/v1';

const DRAFT_ID_PREFIX = 'drafts.';
const OMIT_FIELDS = ['_createdAt', '_updatedAt'];

function sanityAPI(endpoint, method = 'get', data, token, { suppressErrorLogging = false } = {}) {
    return axios({
        method: method,
        url: baseURL + endpoint,
        data: data,
        headers: {
            Authorization: 'Bearer ' + token
        }
    })
        .then(response => {
            return response.data;
        })
        .catch(err => {
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

            if (!suppressErrorLogging) {
                logger.error('Sanity: Error:', { endpoint: endpoint, params: data, response: error });
            }
            throw error;
        });
}

function testToken(token) {
    return sanityAPI(`/auth/oauth/tokens/${token}`, 'get', null, null, { suppressErrorLogging: true }).catch(err => {
        return false;
    });
}

function getUser(token) {
    return sanityAPI('/users/me', 'get', null, token);
}

function getProjects(token) {
    return sanityAPI('/projects', 'get', null, token);
}

function getProjectDatasets(token, sanityProjectId) {
    return sanityAPI(`/projects/${sanityProjectId}/datasets`, 'get', null, token);
}

function createProject(project, token, buildLogger) {
    const projectName = projectUtils.uniqueAlphanumericName(project, project.name);
    return sanityAPI('/projects', 'post', { displayName: projectName }, token).then(sanitySite => {
        buildLogger.debug('Sanity: setting studioHost');
        return setStudioHost(sanitySite, projectName, token);
    });
}

function setStudioHost(sanitySite, projectName, token, retry = true) {
    return sanityAPI(`/projects/${sanitySite.id}`, 'patch', { studioHost: projectName }, token).catch(err => {
        if (retry) {
            return setStudioHost(sanitySite, projectUtils.duplicateProjectName(projectName, true), token, false);
        }

        throw err;
    });
}

function createDeployKey(project, sanityProject, role, token, buildLogger) {
    const sanityProjectId = sanityProject.id;
    const projectName = projectUtils.uniqueAlphanumericName(project, project.name);
    buildLogger.debug('Sanity: creating delivery key', { sanityProjectId: sanityProjectId });

    return sanityAPI(
        `/projects/${sanityProjectId}/tokens`,
        'post',
        {
            label: `stackbit-deploy-${projectName}-${role}`,
            role: role
        },
        token
    );
}

function createStackbitWebhook(project, token, dataset) {
    const sanityProjectId = _.get(project, 'deploymentData.sanity.projectId');
    let webhookHostname = config.server.webhookHostname;

    return sanityAPI(
        `/hooks/projects/${sanityProjectId}`,
        'post',
        {
            dataset: dataset || 'production',
            name: `stackbit-deploy-webhook${dataset && dataset !== 'production' ? `-${dataset}` : ''}`,
            url: `${webhookHostname}/project/${project.id}/webhook/sanity/${dataset || ''}`
        },
        token
    );
}

function deleteStackbitWebbhook(project, token, dataset) {
    const sanityProjectId = _.get(project, 'deploymentData.sanity.projectId');
    const webhookName = `stackbit-deploy-webhook${dataset && dataset !== 'production' ? `-${dataset}` : ''}`;
    return sanityAPI(
        `/hooks/projects/${sanityProjectId}`,
        'get',
        null,
        token
    ).then(webhooks => {
        const webhook = _.find(webhooks, webhook => webhook.name === webhookName);
        if (!webhook) {
            return;
        }
        return sanityAPI(
            `/hooks/projects/${sanityProjectId}/${webhook.id}`,
            'delete',
            {},
            token
        );
    });
}

function deleteProject(project, token) {
    const sanityProjectId = _.get(project, 'deploymentData.sanity.projectId');
    if (!sanityProjectId) {
        return Promise.resolve();
    }

    logger.debug('Sanity: deleting project', {
        sanityProjectId: sanityProjectId,
        projectId: project.id,
        userId: project.ownerId
    });
    return sanityAPI(`/projects/${sanityProjectId}`, 'delete', null, token);
}

async function hasChanges(project, user, { objects, type = 'objects', dataset }) {
    const cmsId = _.get(project, 'wizard.cms.id');
    const srcProjectId = _.get(project, ['deploymentData', cmsId, 'projectId'], '');
    const client = await getClient({ srcProjectId, project, user, dataset, useCdn: true });

    let fetchQuery;
    if (type === 'all') {
        const query = '*[ _id in path($path) ]';
        const path = 'drafts.**';
        fetchQuery = client
            .fetch(query, { path });
    } else {
        const query = '*[ _id in $objectIds ]';
        const draftIds = objects
            .filter(({ srcObjectId }) => !!srcObjectId)
            .map(({ srcObjectId }) => getDraftObjectId(srcObjectId));
        fetchQuery = client.fetch(query, { objectIds: draftIds });
    }

    return fetchQuery.then(results => {
        const validatedObjects = results.map(result => ({
            srcObjectId: getPureObjectId(result._id),
            hasChanges: isDraftId(result._id),
            srcType: 'sanity',
            srcProjectId
        }));
        return {
            hasChanges: validatedObjects.length,
            changedObjects: validatedObjects.filter(({ hasChanges }) => hasChanges)
        };
    });
}

function updatePage(project, user, { changedFields, schema }) {
    logger.debug('Sanity: update page', { projectId: project.id, userId: user.id });
    const fieldsByProject = _.groupBy(changedFields, 'srcProjectId');

    return Promise.all(
        Object.keys(fieldsByProject).map(async srcProjectId => {
            logger.debug('Sanity: update page for project', { projectId: project.id, userId: user.id, srcProjectId });

            const query = '*[_id in $objectIds]';
            const fields = _.map(fieldsByProject[srcProjectId], field => {
                // older containers might still send draft ids
                // for backward compatibility, set all srcObjectId to pure
                return Object.assign(field, {srcObjectId: getPureObjectId(field.srcObjectId)});
            });
            const { srcEnvironment: dataset } = fields[0];
            const client = await getClient({ srcProjectId, project, dataset, user });
            const pureObjectIds = _.map(fields, 'srcObjectId');
            const draftObjectIds = pureObjectIds.map(getDraftObjectId);

            logger.debug('Sanity: fetching objects by ids to update page', { projectId: project.id, userId: user.id, pureObjectIds, draftObjectIds });
            return client
                .fetch(query, { objectIds: [...pureObjectIds, ...draftObjectIds] })
                .then(documents => {
                    return overlayDocumentsWithDrafts(documents)
                        .reduce((transaction, object) => {
                            const fieldsInDocument = _.filter(fields, { srcObjectId: getPureObjectId(object._id) });
                            return fieldsInDocument
                                .reduce((accPromise, field) => {
                                    const cmsSchema = schema[field.srcType][field.srcProjectId];
                                    return accPromise.then(patchDataSet => {
                                        return updatePatchDataSet({ patchDataSet, object, field, client, project, user, schema: cmsSchema });
                                    });
                                }, Promise.resolve({}))
                                .then(patchDataSet => {
                                    if (_.isEmpty(patchDataSet)) {
                                        return transaction;
                                    }

                                    const draftObjectId = getDraftObjectId(object._id);
                                    // you should omit it to be sure it get's the right timestamp from the server
                                    const documentForUpdating = _.omit(object, ['_updatedAt']);

                                    logger.debug('Sanity: updating document', {
                                        projectId: project.id,
                                        userId: user.id,
                                        documentId: object._id
                                    });
                                    logger.debug('Sanity: updating document with patch', {
                                        projectId: project.id,
                                        userId: user.id,
                                        object,
                                        patchDataSet
                                    });

                                    const patch = _.reduce(
                                        patchDataSet,
                                        (result, value, key) => {
                                            if (value === null) {
                                                return {
                                                    ...result,
                                                    unset: result.unset.concat(key)
                                                };
                                            }

                                            return {
                                                ...result,
                                                set: {
                                                    ...result.set,
                                                    [key]: value
                                                }
                                            };
                                        },
                                        {set: {}, unset: []}
                                    );

                                    return transaction
                                        .createIfNotExists({
                                            ...documentForUpdating,
                                            _id: draftObjectId
                                        })
                                        .patch(draftObjectId, patch);
                                });
                        }, client.transaction())
                        .then(transaction => {
                            return transaction.commit().then(result => {
                                logger.debug(`Sanity: Object ${srcProjectId} updated.`, { result });
                                return result;
                            });
                        });
                })
                .catch(err => {
                    logger.debug('[cmss-sanity] failed to update page', { error: err.message, projectId: project.id, userId: user.id });
                    throw err;
                });
        })
    );
}

async function uploadAssets(project, user, { srcEnvironment, srcProjectId, assets }) {
    const client = await getClient({ srcProjectId, project, user, dataset: srcEnvironment });
    const images = await Promise.all(assets.map((asset) => uploadAsset({
        client,
        fileName: _.get(asset, 'metadata.name'),
        url: asset.url
    })));
    return images.map(normalizeAssetObject);
}

async function hasAccess(project, user) {
    const { token } = await getProjectDataSetAndUserToken(project, user);
    const cmsId = _.get(project, 'wizard.cms.id');
    const srcProjectId = _.get(project, ['deploymentData', cmsId, 'projectId'], '');

    if (!token) {
        return {
            hasConnection: false,
            hasPermissions: null
        };
    }

    return testToken(token).then(async (res) => {
        const tokenExpiresAt = new Date(_.get(res, 'accessTokenExpiresAt', Date.now()));
        const tokenExpired = (new Date() - tokenExpiresAt) > 0;
        if (!res || tokenExpired) {
            return {
                hasConnection: false,
                hasPermissions: null
            };
        }
        const query = `*[_type == 'system.group'] {_id}`;
        const client = await getClient({ srcProjectId, project, user });
        return client.fetch(query).then(() => {
            return {
                hasConnection: true,
                hasPermissions: true
            };
        }).catch(err => {
            return {
                hasConnection: true,
                hasPermissions: false
            };
        });
    });
}

function publishDrafts(project, user, { objects, type = 'objects' }, environmentName) {
    if (_.isEmpty(objects)) {
        return Promise.resolve();
    }
    const projectId = project.getDeploymentData('sanity.projectId', environmentName);
    const dataset = project.getDeploymentData('sanity.dataset', environmentName);
    logger.debug('Sanity: publish drafts', { projectId: project.id, userId: user.id, objects, sanityProjectId: projectId, dataset });
    const fieldsByProject = type === 'all' ? { [projectId]: [{ srcProjectId: projectId, srcEnvironment: dataset }] } : _.groupBy(objects, 'srcProjectId');
    return Promise.all(
        Object.keys(fieldsByProject).map(async srcProjectId => {
            const { srcEnvironment: fieldDataset } = objects[0];
            const client = await getClient({ srcProjectId, project, dataset: dataset || fieldDataset, user });
            let fetchQuery;
            if (type === 'all') {
                const query = '*[ _id in path($path) ]';
                const path = 'drafts.**';
                fetchQuery = client
                    .fetch(query, { path });
            } else {
                const publishedObjectIds = fieldsByProject[srcProjectId]
                    .filter(({ srcObjectId }) => !!srcObjectId)
                    .map(({ srcObjectId }) => getPureObjectId(srcObjectId));
                const draftObjectIds = publishedObjectIds.map(srcObjectId => getDraftObjectId(srcObjectId));
                const query = '*[ _id in $objectIds ]';
                fetchQuery = client
                    .fetch(query, { objectIds: [...draftObjectIds, ...publishedObjectIds] });
            }

            return fetchQuery
                .then(objects => {
                    logger.debug('Sanity: publish drafts. Patch objects', {
                        projectId: project.id,
                        userId: user.id,
                        objects
                    });

                    if (!objects.length) {
                        return Promise.resolve({});
                    }

                    const draftObjects = _.filter(objects, object => isDraftId(_.get(object, '_id')));
                    const transaction = draftObjects.reduce((transaction, object) => {
                        const documentId = _.get(object, '_id');
                        const publishedDocument = _.find(objects, { _id: getPureObjectId(documentId) });

                        if (publishedDocument) {
                            transaction = transaction
                                .patch(_.get(publishedDocument, '_id'), {
                                    // borrowed form Sanity folks - https://github.com/sanity-io/sanity/blob/c3c875ed51bf49ebceedc40abe50ad17ccbf489b/packages/%40sanity/desk-tool/src/pane/DocumentPane.js#L860
                                    // Hack until other mutations support revision locking
                                    unset: ['_reserved_prop_'],
                                    ifRevisionID: _.get(publishedDocument, '_rev')
                                });
                        }

                        // you should omit it to be sure it get's the right timestamp from the server
                        const documentForPublishing = _.omit(object, ['_updatedAt']);

                        logger.debug('Sanity: publish drafts. Patch object', {
                            projectId: project.id,
                            userId: user.id,
                            documentId: getPureObjectId(documentId)
                        });
                        return transaction
                            .createOrReplace({
                                ...documentForPublishing,
                                _id: getPureObjectId(documentId)
                            })
                            .delete(documentId);
                    }, client.transaction());

                    return transaction.commit().then(result => {
                        logger.debug(`Sanity: Object ${srcProjectId} published.`, { result });
                        return result;
                    });
                })
                .catch(err => {
                    logger.error('[cmss-sanity] failed to publish drafts', {
                        error: err.message,
                        projectId: project.id,
                        userId: user.id
                    });
                    throw err;
                });
        })
    );
}

async function duplicatePage(project, user, { pageId, srcProjectId, duplicatableModels, fields, srcEnvironment, schema, pageModel }) {
    logger.debug('Sanity: duplicate page', { srcProjectId: srcProjectId, projectId: project.id, userId: user.id });

    fields = updateSlugField(pageModel, fields);
    const client = await getClient({ srcProjectId, project, dataset: srcEnvironment, user });
    const query = '*[ _id in $objectIds ]';
    return client
        .fetch(query, { objectIds: [pageId, getDraftObjectId(pageId)] })
        .then(documents => {
            documents = overlayDocumentsWithDrafts(documents);
            if (_.isEmpty(documents)) {
                return Promise.resolve({});
            }
            return _.head(documents);
        })
        .then(object => {
            return duplicateReferences({ objectOrField: object, client, duplicatableModels, schema }).then(() => object);
        })
        .then(object => {
            let newObject = {
                ...object,
                ...formatAdditionalFields({ fields, modelSchema: schema[object._type] }),
                // creating draft object
                _id: DRAFT_ID_PREFIX
            };
            newObject = _.omit(newObject, OMIT_FIELDS);
            return client.create(newObject);
        })
        .then(object => {
            return {
                // return pure object id because only Sanity service can handle `drafts.`, other just use pure ids
                id: getPureObjectId(object._id),
                srcProjectId
            };
        })
        .catch(err => {
            logger.error('Sanity: Failed to duplicate a page', {
                error: err,
                projectId: project.id,
                userId: user.id,
                objectId: pageId
            });
            throw err;
        });
}

async function createPage(project, user, { modelName, schema, srcProjectId, srcEnvironment, fields, duplicatableModels, pageModel }) {
    logger.debug('Sanity: create page', { srcProjectId: srcProjectId, projectId: project.id, userId: user.id });

    fields = updateSlugField(pageModel, fields);
    const client = await getClient({ srcProjectId, project, dataset: srcEnvironment, user });
    return createObject({ modelName, client, duplicatableModels, fields, schema })
        .then(object => {
            return {
                // return pure object id because only Sanity service can handle `drafts.`, other just use pure ids
                id: getPureObjectId(object._id),
                srcProjectId: srcProjectId
            };
        })
        .catch(err => {
            logger.error('Sanity: Failed to create a page', {
                error: err,
                projectId: project.id,
                userId: user.id,
                objectType: modelName
            });
            throw err;
        });
}

function updatePatchDataSet({ patchDataSet, object, field, client, project, user, schema }) {
    const obj = _.cloneDeep(object);
    const fieldPathString = fieldPathToString(field.fieldPath);

    const fieldModel = getFieldModelAtFieldPath({
        object,
        model: schema[object._type],
        modelsByName: _.keyBy(schema, 'name'),
        fieldPath: field.fieldPath,
    });

    let promise;

    if (field.order) {
        const objectFieldValue = _.get(obj, fieldPathString, []);
        promise = Promise.resolve(field.order.map(newIndex => objectFieldValue[newIndex]));
    } else if (field.add) {
        const { selectedModelName, selectedObjectId = null, pageModels = [], values } = field.add;
        const objectFieldValue = _.get(obj, fieldPathString, []);
        const { listItemsField, model } = getListItemsFieldAndModelForNewListItem({ fieldModel, selectedModelName, schema });
        const { position = objectFieldValue.length } = field.add;
        promise = addValueToList({
            client,
            fieldType: listItemsField.type,
            model,
            pageModels,
            selectedObjectId,
            object,
            objectFieldValue,
            project,
            user,
            schema,
            values,
            position
        });
    } else if (field.remove) {
        promise = Promise.resolve(removeValueFromObject({ field, object: obj, project, user }));
    } else if (field.setObject) {
        const { selectedModelName, selectedObjectId = null, pageModels = [], values } = field.setObject;
        if (!selectedObjectId && !selectedModelName) {
            throw new Error('Expected to set an object field, but missing model name or object id');
        }
        promise = setValueToObjectField({client, fieldModel, selectedModelName, pageModels, selectedObjectId, object: obj, fieldPathString, project, user, schema, values });
    } else if (field.linkAsset) {
        promise = field.linkAsset.id
            ? Promise.resolve(normalizeValueToCMSFormat({ value: field.linkAsset.id, type: 'image' }))
            : Promise.resolve(null);
    } else if (field.uploadAsset) {
        promise = uploadAsset({
            client,
            fileName: _.get(field.uploadAsset, 'metadata.name'),
            url: field.uploadAsset.url
        }).then(asset => {
            return normalizeValueToCMSFormat({ value: asset._id, type: 'image' });
        });

    } else if (field.value !== undefined) {
        promise = Promise.resolve(normalizeValueToCMSFormat({ value: field.value, type: fieldModel.type }));
    } else {
        throw new Error(`Unrecognized field action: ${Object.keys(field).toString()}`);
    }

    return promise.then((value) => {
        patchDataSet[fieldPathString] = value;
        return patchDataSet;
    });
}

function normalizeValueToCMSFormat({ value, type }) {
    switch (type) {
    case 'image':
        return {
            _type: 'image',
            asset: {
                _ref: value,
                _type: 'reference'
            }
        };
    case 'slug':
        return {
            _type: type,
            current: value
        };
    case 'richText':
        // @todo get from IM schema
        // similar to Sanity recipe: const blockContentType = defaultSchema.get('blogPost').fields.find(field => field.name === 'body').type
        // but using Identity Mapper schema related to original object.
        const defaultSchema = SanitySchema.compile({
            name: 'default',
            types: [
                {
                    type: 'object',
                    name: 'default',
                    fields: [
                        {
                            type: 'array',
                            of: [{type: 'block'}]
                        }
                    ]
                }
            ]
        });
        const blockContentType = defaultSchema.get('default').fields[0].type;
        return blockTools.htmlToBlocks(value, blockContentType, {
            parseHtml: html => new JSDOM(html).window.document
        });
    default:
        return value;
    }
}

function addValueToList({ client, fieldType, model, pageModels, selectedObjectId = null, objectFieldValue, project, user, schema, values, position }) {
    logger.debug('Sanity adding new value to object', { projectId: project.id, userId: user.id, newValue: objectFieldValue, position });
    if (!_.includes(['model', 'models', 'object', 'reference', 'image'], fieldType)) {
        objectFieldValue.splice(position, 0, getFieldDefaultValue(fieldType));
        return Promise.resolve(objectFieldValue);
    } else if (_.includes(['reference'], fieldType)) {
        const pageModel = _.find(pageModels, ({ modelName }) => modelName === model.name);
        const pageFields = {
            ..._.get(pageModel, 'fields'),
            ...values
        };
        // since it will be a rootObject it has to be published
        const objectPromise = selectedObjectId
            ? Promise.resolve({ _id: selectedObjectId })                                                        // link existing object
            : createObject({ client, modelName: model.name, fields: pageFields, schema, draft: false });        // create new object to link
        return objectPromise.then(object => {
            const reference = {
                // key has to be present and be unique - https://www.sanity.io/docs/array-type
                _key: uuid(),
                _ref: object._id,
                _type: 'reference'
            };
            objectFieldValue.splice(position, 0, reference);
            return objectFieldValue;
        });
    } else if (fieldType === 'image') {
        if (_.isEmpty(objectFieldValue)) {
            // fetch first existing image
            const query = `*[_id match 'image-'][0]`;
            return client
                .fetch(query)
                .then(asset => {
                    const id = _.get(asset, '_id');
                    if (id) {
                        objectFieldValue.splice(position, 0, {
                            _key: uuid(),
                            _type: 'image',
                            asset: {
                                _ref: id,
                                _type: 'reference'
                            }
                        });
                        return objectFieldValue;
                    } else {
                        throw new Error('There are no images in the CMS library. Please add at least one image to COM library and try again.');
                    }
                });
        } else {
            // API doesn't support default images
            // if object already has images - get first image and push it as new value
            objectFieldValue.splice(position, 0, {
                ..._.head(objectFieldValue),
                _key: uuid()
            });

            return Promise.resolve(objectFieldValue);
        }
    } else {
        const value = {
            ...getDefaultFieldsFromModel(model, schema),
            ...values
        };
        objectFieldValue.splice(position, 0, {
            // key has to be present and be unique - https://www.sanity.io/docs/array-type
            _key: uuid(),
            _type: model.name || model.type,
            ...value
        });

        return Promise.resolve(objectFieldValue);
    }
}

function setValueToObjectField({ client, fieldModel, selectedModelName, pageModels, selectedObjectId = null, project, user, schema, values }) {
    logger.debug('Sanity setting new value to object', { projectId: project.id, userId: user.id, fieldType: fieldModel.type });

    if (_.includes(['reference'], fieldModel.type)) {
        let objectPromise;
        if (selectedObjectId) {
            // link existing object
            objectPromise = Promise.resolve({ _id: selectedObjectId });
        } else {
            // create new object to link
            const pageModel = _.find(pageModels, ({ modelName }) => modelName === selectedModelName);
            const pageFields = {
                ..._.get(pageModel, 'fields'),
                ...values
            };
            objectPromise = createObject({ client, modelName: selectedModelName, fields: pageFields, schema, draft: false });
        }
        return objectPromise.then(object => {
            return {
                // key has to be present and be unique - https://www.sanity.io/docs/array-type
                _key: uuid(),
                _ref: object._id,
                _type: 'reference'
            };
        });
    } else if (_.includes(['model', 'models', 'object'], fieldModel.type)) {
        const defaultFields = getDefaultFieldsFromModel(fieldModel, schema);
        let modelSchema = fieldModel;
        let additionalFields = {};
        if (fieldModel.type === 'model') {
            let modelName;
            if (fieldModel.model) {
                // DEPRECATION NOTICE: fieldModel.model of itemType === 'model' is deprecated and can be removed after release of V2
                modelName = fieldModel.model;
            } else {
                modelName = selectedModelName || _.get(fieldModel, 'models.0');
            }
            modelSchema = _.get(schema, modelName);
            additionalFields = { _type: modelName };
        } else if (fieldModel.type === 'models') {
            // DEPRECATION NOTICE: itemType === 'models' is deprecated and can be removed after release of V2
            const modelName = selectedModelName || _.get(fieldModel, 'models.0');
            modelSchema = _.get(schema, modelName);
            additionalFields = { _type: modelName };
        }
        return Promise.resolve({
            ...additionalFields,
            ...values,
            ...formatAdditionalFields({ fields: defaultFields, modelSchema })
        });
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
        const modelName = _.get(object, '_type');
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
        return getFieldModelAtFieldPath({
            object: object[fieldName],
            fieldPath: fieldPathTail,
            model: getFieldModelOfListItem(model, object[fieldName]),
            modelsByName
        });
    }
}

function getFieldModelOfListItem(listModel, listItem) {
    if (!_.isArray(listModel.items)) {
        return listModel.items;
    }
    const itemModels = _.get(listModel, 'items');
    const listItemType = _.get(listItem, '_type');
    // if _type is no defined, then it is primitive type, use regular typeof,
    // javascript types are the same as sanity primitive types (string, number, boolean)
    if (!listItemType) {
        const type = typeof listItem;
        return _.defaults({type: type});
    }
    if (listItemType === 'reference') {
        return _.find(itemModels, {type: 'reference'});
    } else {
        let itemModel = _.find(itemModels, itemModel => {
            // DEPRECATION NOTICE: itemModel.type === 'models' is deprecated and can be removed after release of V2
            if (itemModel.type === 'models') {
                return _.includes(itemModel.models, listItemType);
            } else if (itemModel.type === 'model') {
                // DEPRECATION NOTICE: itemModel.model of itemModel.type === 'model' is deprecated and can be removed after release of V2
                return itemModel.model ? itemModel.model === listItemType : _.includes(itemModel.models, listItemType);
            } else {
                // if field was one of base types (object, image, slug, etc.)
                // and it had a "name" property, then the "_type" will be equal to that name,
                // otherwise the "_type" will be equal to the base type
                return itemModel.name === listItemType || itemModel.type === listItemType;
            }
        });
        if (!itemModel) {
            throw new Error('Could not resolve model of an list item');
        }
        return itemModel;
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
            // In sanity, if an array item model is one of the base types (object, image, slug, etc.)
            // and the item model has the "name" property, then "selectedModelName" will be equal to that name,
            // otherwise, "selectedModelName" will be equal to the item model's type
            return _itemModel.name === selectedModelName || _itemModel.type === selectedModelName;
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

function removeValueFromObject({ field, object, project, user }) {
    const { index = null} = _.get(field, 'remove', {});
    let fieldPathStr = fieldPathToString(field.fieldPath);
    const objectFieldValue = field.fieldPath.length ? _.get(object, fieldPathStr) : object;

    if (_.isArray(objectFieldValue) && index !== null) {
        const removedValue = _.pullAt(objectFieldValue, [index]);
        logger.debug('Sanity removing value from list', { projectId: project.id, userId: user.id, object, fieldPathStr, removedValue });
        return objectFieldValue;
    } else {
        logger.debug('Sanity removing value from object', { projectId: project.id, userId: user.id, object, fieldPathStr });
        return null;
    }
}

async function getProjectDataSetAndUserToken(project, user) {
    const { getAccessTokenToProjectCMS } = require('../project-services/project-service');
    const cmsId = _.get(project, 'wizard.cms.id');

    // Sanity token taken from user.connections

    const token = await getAccessTokenToProjectCMS(user, project);
    // Sanity projectId taken from project.deploymentData
    const dataset = _.get(project, ['deploymentData', cmsId, 'dataset'], 'production');

    return {
        dataset,
        token
    };
}

async function getClient({ srcProjectId, project, user, dataset, useCdn = false }) {
    const { dataset: defaultDataset, token } = await getProjectDataSetAndUserToken(project, user);

    return sanityClient({
        projectId: srcProjectId,
        dataset: dataset || defaultDataset,
        token,
        useCdn
    });
}

/**
 * Gets an array of drafts and published documents and returns an array of documents
 * with drafts overlaying published documents.
 * - If published document has a draft counterpart, the draft document will be returned.
 * - If published document does not have a draft counterpart, the published document will be returned.
 * - If draft document does not have a published counterpart, the draft document will be returned.
 *
 * @example
 * overlayDocumentsWithDrafts([
 *   {_id: "a", title: "A"},
 *   {_id: "b", title: "B"},
 *   {_id: "drafts.b", title: "B draft"},
 *   {_id: "drafts.c", title: "C draft"},
 * ]) => [
 *   {_id: "a", title: "A"},
 *   {_id: "drafts.b", title: "B draft"},
 *   {_id: "drafts.c", title: "C draft"},
 * ]
 *
 * @param documents
 * @return {Array}
 */
function overlayDocumentsWithDrafts(documents) {
    const docGroups = _.groupBy(documents, doc => isDraftId(doc._id) ? 'drafts' : 'published');
    const documentsByPureId = _.keyBy(docGroups.published, '_id');
    _.forEach(docGroups.drafts, doc => {
        documentsByPureId[getPureObjectId(doc._id)] = doc;
    });
    return _.values(documentsByPureId);
}

function getPureObjectId(srcObjectId) {
    return isDraftId(srcObjectId) ? srcObjectId.replace(DRAFT_ID_PREFIX, '') : srcObjectId;
}

function getDraftObjectId(srcObjectId) {
    return isDraftId(srcObjectId) ? srcObjectId : `${DRAFT_ID_PREFIX}${srcObjectId}`;
}

function isDraftId(srcObjectId) {
    return srcObjectId && srcObjectId.startsWith(DRAFT_ID_PREFIX);
}

function duplicateReferences({ objectOrField, client, schema, duplicatableModels = [] }) {
    return Promise.all(
        Object.values(objectOrField).map(field => {
            if (_.get(field, '_type') === 'reference') {
                const query = '*[_id == $refId]';
                return client.fetch(query, { refId: _.get(field, '_ref') }).then(result => {
                    const object = _.head(result);
                    const modelName = _.get(object, '_type');
                    if (duplicatableModels.includes(modelName)) {
                        return createObject({
                            client,
                            modelName,
                            fields: object,
                            schema,
                            draft: false,
                            duplicatableModels
                        }).then(refObject => {
                            field._ref = refObject._id;
                            return refObject;
                        });
                    }
                    return Promise.resolve();
                });
            }

            if ((_.isArray(field) || _.isObject(field)) && !_.isEmpty(field)) {
                return duplicateReferences({ objectOrField: field, client, duplicatableModels, schema });
            }

            return Promise.resolve();
        })
    );
}

function createObject({ client, modelName, schema = {}, fields = {}, draft = true, duplicatableModels = [] }) {
    const modelSchema = _.get(schema, modelName);
    const defaultFields = getDefaultFieldsFromModel(modelSchema, schema);
    const allFields = { ...defaultFields, ...fields };

    let object = {
        _type: modelName,
        ...formatAdditionalFields({ fields: allFields, modelSchema }),
    };

    if (draft) {
        // creating draft object
        object._id = DRAFT_ID_PREFIX;
        object = _.omit(object, OMIT_FIELDS);
    } else {
        object = _.omit(object, ['_id', ...OMIT_FIELDS]);
    }

    return duplicateReferences({ objectOrField: object, client, duplicatableModels, schema }).then(() => {
        return client.create(object);
    });
}

async function deleteObject(project, user, { deleteDraft, srcEnvironment, srcObjectId, srcProjectId }) {
    if (!srcObjectId) {
        throw new Error('Missing object ID');
    }

    logger.debug('Sanity: delete object', { srcObjectId, srcProjectId, projectId: project.id, userId: user.id });

    const client = await getClient({ srcProjectId, project, dataset: srcEnvironment, user });
    const draftObjectId = getDraftObjectId(srcObjectId);

    return Promise.all([
        client.delete(srcObjectId),
        deleteDraft && client.delete(draftObjectId)
    ]);
}

function formatAdditionalFields({ fields, modelSchema }) {
    return Object.keys(fields).reduce((acc, fieldName) => {
        const modelField = _.find(modelSchema.fields, { name: fieldName });
        const value = fields[fieldName];

        acc[fieldName] = normalizeValueToCMSFormat({ value, type: modelField.type });

        return acc;
    }, {});
}

function normalizeAssetObject(asset) {
    return {
        objectId: asset._id,
        url: asset.url,
        createdAt: asset._createdAt,
        fileName: asset.originalFilename,
        width: _.get(asset, 'metadata.dimensions.width'),
        height: _.get(asset, 'metadata.dimensions.height'),
        size: asset.size
    };
}

async function getAssets(project, user, {pageId, pageSize, searchQuery, srcProjectId, srcEnvironment}) {
    logger.debug('Sanity: get assets', { srcProjectId, userId: user.id });

    const pageNumber = typeof pageId === 'number' ? pageId : 1;
    const sliceStart = (pageNumber - 1) * pageSize;
    const sliceEnd = (sliceStart + pageSize) - 1;
    const listQuery = `*[_type == "sanity.imageAsset" && originalFilename match "*${searchQuery}*"][${sliceStart}..${sliceEnd}] | order(_createdAt desc)`;
    const countQuery = 'count(*[_type == "sanity.imageAsset"])';
    const client = await getClient({ srcProjectId, project, dataset: srcEnvironment, user });

    return client.fetch(countQuery, {}).then(count => {
        // If we're paginating past the number of total results, there's no
        // point in hitting the CMS again. We can return early.
        if (count <= (sliceStart + 1)) {
            return {
                data: [],
                meta: {
                    nextPage: null
                }
            };
        }

        return client.fetch(listQuery, {}).then(results => {
            const data = results.map(normalizeAssetObject);
            const hasNextPage = count > (pageNumber * pageSize);

            return {
                data,
                meta: {
                    nextPage: hasNextPage ? pageNumber + 1 : null
                }
            };
        });
    }).catch(err => {
        logger.error('Sanity: Failed to get assets', {
            error: err,
            projectId: project.id,
            userId: user.id,
            pageId,
            pageSize
        });

        throw err;
    });
}

function uploadAsset({client, fileName, type = 'image', url}) {
    return new Promise((resolve, reject) => {
        https.get(url, downloadStream => {
            client.assets.upload(type, downloadStream, {filename: fileName})
                .then(resolve)
                .catch(reject);
        });
    });
}

function createDataset(srcProjectId, token, newDataset) {
    return sanityAPI(`/projects/${srcProjectId}/datasets/${newDataset}`, 'put', {
        aclMode: 'private'
    }, token);
}

function importDataset({ project, user, exportFilePath, sanityProjectId, dataset, token, useCdn, operation, allowAssetsInDifferentDataset }) {
    logger.debug('import sanity project', { exportFilePath, sanityProjectId, dataset, project: project.id, user: user.id });
    const client = sanityClient({
        projectId: sanityProjectId,
        dataset: dataset,
        token: token,
        useCdn: useCdn
    });
    const inputStream = fs.createReadStream(exportFilePath);
    return sanityImport(inputStream, {
        client: client,
        operation: operation,
        allowAssetsInDifferentDataset: allowAssetsInDifferentDataset
    }).then(({ numDocs, warnings }) => {
        logger.debug('sanity import success', { numDocs, warnings, project: project.id, user: user.id });
    }).catch(error => {
        logger.error('sanity import failed', { error, project: project.id, user: user.id });
        throw error;
    });
}

function deleteDataset(srcProjectId, token, dataset) {
    return sanityAPI(`/projects/${srcProjectId}/datasets/${dataset}`, 'delete', {}, token);
}

async function checkDataset(project, user, srcProjectId, token, dataset) {
    const client = await getClient({ srcProjectId, project, user, dataset, useCdn: true });
    return client.fetch('*[0..9]').then(res => {
        return res && res.length > 0;
    });
}

async function migrateToDataset(project, user, srcProjectId, fromDataset, toDataset) {
    logger.debug('Sanity: migrate to dataset', {fromDataset, toDataset});
    const cmsId = _.get(project, 'wizard.cms.id');
    const token = _.get(_.find(user.connections, { type: cmsId }), 'accessToken');
    const fromDatasetIsValid = await checkDataset(project, user, srcProjectId, token, fromDataset);
    if (!fromDatasetIsValid) {
        throw new Error(`Dataset '${fromDataset}' is invalid`);
    }
    // backup toDataset
    const exportFileName = path.join(os.tmpdir(), `${uuid()}.tar.gz`);
    await sanityExport({
        client: sanityClient({
            projectId: srcProjectId,
            dataset: toDataset,
            token
        }),
        dataset: toDataset,
        outputPath: exportFileName,
        drafts: true,
    });
    logger.debug('Sanity: exported dataset', {fromDataset, toDataset});
    try {
        await deleteDataset(srcProjectId, token, toDataset);
        logger.debug('Sanity: deleted dataset', {fromDataset, toDataset});
        await createDatasetCopies(project, user, srcProjectId, fromDataset, [toDataset]);
        logger.debug('Sanity: created copy', {fromDataset, toDataset});
    } catch (err) {
        logger.debug('Sanity: error occurred. restoring dataset...', {fromDataset, toDataset});
        try {
            await createDataset(srcProjectId, token, toDataset);
        } finally {
            await importDataset({
                project,
                user,
                exportFilePath: exportFileName,
                sanityProjectId: srcProjectId,
                dataset: toDataset,
                token,
                useCdn: false,
                operation: 'createOrReplace',
                allowAssetsInDifferentDataset: true
            });
        }
        throw err;
    } finally {
        await fse.remove(exportFileName);
    }
}

function createDatasetCopies(project, user, srcProjectId, fromDataset, newDatasets) {
    const cmsId = _.get(project, 'wizard.cms.id');
    const token = _.get(_.find(user.connections, { type: cmsId }), 'accessToken');
    const exportFileName = path.join(os.tmpdir(), `${uuid()}.tar.gz`);
    logger.debug('Sanity: creating dataset', {fromDataset, newDatasets});
    return Promise.all(newDatasets.map(newDataset => {
        return createDataset(srcProjectId, token, newDataset);
    })).then(() => {
        return sanityExport({
            client: sanityClient({
                projectId: srcProjectId,
                dataset: fromDataset,
                token
            }),
            dataset: fromDataset,
            outputPath: exportFileName,
            drafts: true,
        });
    }).then(() => {
        logger.debug('Sanity: importing dataset', {fromDataset, newDatasets});
        return Promise.all(newDatasets.map(newDataset => {
            return importDataset({
                project,
                user,
                exportFilePath: exportFileName,
                sanityProjectId: srcProjectId,
                dataset: newDataset,
                token,
                useCdn: false,
                operation: 'createOrReplace',
                allowAssetsInDifferentDataset: true
            });
        }));
    }).finally(() => {
        return fse.remove(exportFileName).catch(err => {
            logger.debug('error removing file', {err});
        });
    });
}

module.exports = {
    createProject,
    deleteProject,
    createStackbitWebhook,
    deleteStackbitWebbhook,
    createDeployKey,
    createDataset,
    importDataset,
    createDatasetCopies,
    migrateToDataset,
    deleteDataset,
    testToken,
    hasChanges,
    updatePage,
    uploadAssets,
    hasAccess,
    publishDrafts,
    duplicatePage,
    createPage,
    deleteObject,
    getAssets,
    getUser,
    getProjects,
    getProjectDatasets
};
