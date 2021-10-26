const contentful = require('contentful-management');
const logger = require('../logger');
const _ = require('lodash');
const axios = require('axios');
const { TaskQueue } = require('@stackbit/utils');
const errorUtils = require('../utils/error.utils');
const { getFieldDefaultValue, getDefaultFieldsFromModel, updateSlugField } = require('../utils/cms.utils');
const { getAccessTokenToProjectCMS } = require('../project-services/project-service');
const config = require('../../config').default;
const contentfulProjectService = require('./contentful-project-service');
const { processEntryErrors } = require('./contentful-error-service');

const PAGE_SIZE_FOR_DEFAULT_IMAGE = 1;

// The number of times to retry an update in case of a conflict (i.e. 409 response).
const UPDATE_RETRY_COUNT = 1;

const WEBHOOK_NAME = 'stackbit-deploy-webhook';

function createSpace(project, token, buildLogger) {
    const spaceName = project.name.substr(0, 30); // contentful space name limit
    const projectOrgId = _.get(project, 'wizard.cms.settings.orgId');

    buildLogger.debug('Contentful: creating space', {name: spaceName});
    return contentful.createClient({
        accessToken: token
    }).createSpace({
        name: spaceName
    }, projectOrgId);
}

function getSpace(id, token) {
    return contentful.createClient({ accessToken: token }).getSpace(id);
}

function createApiKeys(project, space, token, keyName, retry = 0) {
    const spaceName = space.name;
    const spaceId = _.get(space, 'sys.id');
    logger.debug('Contentful: creating api keys', {
        name: spaceName,
        projectId: project.id,
        userId: project.ownerId
    });

    return contentful.createClient({
        accessToken: token,
    }).getSpace(spaceId).then(space => {
        return space.createApiKey({
            name: `${(keyName || spaceName).substr(0, 40 - 16)}-stackbit-deploy`   // max length of key is 40 chars
        }).then(apiKey => {
            const previewApiKeyId = _.get(apiKey, 'preview_api_key.sys.id');
            return space.getPreviewApiKey(previewApiKeyId).then(previewApiKey => {
                return {
                    deliveryApiKey: apiKey.accessToken,
                    previewApiKey: previewApiKey.accessToken,
                    apiKeyId: _.get(apiKey, 'sys.id')
                };
            });
        }).catch(err => {
            let errObj = err;
            try {
                errObj = JSON.parse(err.message);
            } catch (parseErr) {
                logger.debug('Contentful: cannot parse err message from space.createApiKey() or space.getPreviewApiKey()');
            }
            if (_.get(errObj, 'details.errors[0].name') === 'taken') {
                if (retry > 1) {    // retry twice
                    throw 'Contentful: apiKey name already exists';
                }
                let randomHash = Math.random().toString(36).substring(7);
                return createApiKeys(project, space, token, `${randomHash}-${keyName}`, retry+1);
            }

            logger.debug('Failed to create API key for contentful space', {
                error: err,
                projectId: project.id,
                userId: project.ownerId
            });
            throw err;
        });
    });
}

function createPersonalAccessToken(project, space, token) {
    const spaceName = space.name;
    logger.debug('Contentful: creating Personal Access Token', {
        name: spaceName,
        projectId: project.id,
        userId: project.ownerId
    });

    return contentful.createClient({
        accessToken: token,
    }).createPersonalAccessToken({
        name: `${spaceName}-stackbit-manage`,
        scopes: [
            'content_management_manage'
        ]
    });
}

function createStackbitWebhook(project, token) {
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    return contentful.createClient({
        accessToken: token
    }).getSpace(spaceId).then(space => {
        let webhookHostname = config.server.webhookHostname;
        space.createWebhook({
            url: `${webhookHostname}/project/${project.id}/webhook/contentful`,
            name: WEBHOOK_NAME,
            topics: ['*.*'],
            transformation: {
                contentType: 'application/json'
            }
        });
    });
}

async function applyStackbitWebhookToAllEnvironments(project, user) {
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    const accessToken = await getAccessTokenToProjectCMS(user, project);
    return getSpaceClient(project, user, spaceId).then(space => {
        return space.getWebhooks().then(webhooks => {
            const webhook = _.find(webhooks.toPlainObject().items, webhook => webhook.name === WEBHOOK_NAME);
            if (webhook && !_.isEqual(webhook.filters, [])) {
                return axios.put(`https://api.contentful.com/spaces/${spaceId}/webhook_definitions/${webhook.sys.id}`, {
                    ...webhook,
                    filters: []
                }, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/vnd.contentful.management.v1+json'
                    }
                }).then(response => {
                    return response.data;
                });
            }
        });
    });
}

function deleteSpace(project, token) {
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    if (!spaceId) {
        return Promise.resolve();
    }

    logger.debug('Contentful: deleting space', {spaceId: spaceId, projectId: project.id, userId: project.ownerId});
    return contentful.createClient({
        accessToken: token
    })
        .getSpace(spaceId)
        .then(space => space.delete())
        .catch(err => {
            if (err && err.name === 'NotFound') {
                return true; // if space was already deleted
            }
            throw err;
        });
}

function duplicateEntry(locale, environment, entryOrId, duplicatableModels, isNested=false, handler = () => {}) {
    return (typeof entryOrId === 'string' ? environment.getEntry(entryOrId) : Promise.resolve(entryOrId))
        .then((entry) => {
            const contentType = _.get(entry, 'sys.contentType.sys.id');
            if (isNested && !duplicatableModels.includes(contentType)) {
                return [entry, false];
            }
            const newEntry = _.cloneDeep(entry);
            handler(newEntry);
            return Promise.all(
                Object.keys(newEntry.fields).map(fieldName => {
                    const field = newEntry.fields[fieldName];
                    const fieldSys = _.get(field, `${locale}.sys`, _.get(field, 'sys'));
                    let isExistingReference = fieldSys && fieldSys.linkType === 'Entry' && fieldSys.id;
                    let isNewReference = duplicatableModels.includes(_.get(fieldSys, 'contentType.sys.id'));
                    if (isExistingReference || isNewReference) {
                        let entryOrId = isExistingReference ? fieldSys.id : field[locale];
                        return duplicateEntry(locale, environment, entryOrId, duplicatableModels, true).then(duplicatedEntry => {
                            newEntry.fields[fieldName] = _.set({}, locale, {
                                sys: {
                                    type: 'Link',
                                    linkType: 'Entry',
                                    id: _.get(duplicatedEntry, 'sys.id')
                                }
                            });
                        });
                    }
                    return Promise.resolve();
                })
            ).then(() => [newEntry, true]);
        })
        .then(([entry, shouldCreate]) => {
            const contentType = _.get(entry, 'sys.contentType.sys.id');
            const newEntry = { fields: entry.fields };
            if (shouldCreate) {
                return environment.createEntry(contentType, newEntry);
            }
            return entry;
        });
}

async function getSpaceClient(project, user, spaceId) {
    const accessToken = await getAccessTokenToProjectCMS(user, project);
    const space = contentfulProjectService.getSpaceById(project, spaceId);
    return contentful
        .createClient({accessToken})
        .getSpace(space.spaceId);
}

async function getEnvironmentClientFromUserProjectAndSpaceId(user, project, spaceId, environment) {
    const accessToken = await getAccessTokenToProjectCMS(user, project);
    const space = contentfulProjectService.getSpaceById(project, spaceId);
    return getEnvironmentClientFromAccessTokenAndSpace(accessToken, space, environment);
}

function getEnvironmentClientFromAccessTokenAndSpace(accessToken, space, environment) {
    const env = environment || _.get(space, 'environment', 'master');
    return contentful
        .createClient({accessToken})
        .getSpace(space.spaceId)
        .then(spaceRes => spaceRes.getEnvironment(env));
}

async function createPage(project, user, {modelName, srcProjectId, srcEnvironment, fields, duplicatableModels = [], schema, pageModel, locales, params = {}}) {
    logger.debug('Contentful: create page', {spaceId: srcProjectId, projectId: project.id, userId: user.id});
    const env = await getEnvironmentClientFromUserProjectAndSpaceId(user, project, srcProjectId, srcEnvironment);
    const newEntry = {
        sys: {
            contentType: {
                sys: {
                    id: modelName
                }
            }
        },
        fields: {}
    };

    const model = _.get(schema, modelName, {});
    const defaultLocale = params.defaultLocale || contentfulProjectService.getLocale(project, srcProjectId);
    const getDefaultImage = makeDefaultImageGetter(project, user, srcProjectId, env);
    fields = updateSlugField(pageModel, fields);
    const entryFields = _.assign(await getDefaultFieldsForCMSFromModel(model, schema, {getDefaultImage, duplicatableModels, locale: defaultLocale, createReferences: true}), fields);
    _.forEach(entryFields, (fieldValue, fieldName) => {
        const fieldModel = _.find(_.get(model, 'fields'), { name: fieldName });
        if (fieldModel.localized && locales) {
            return _.forEach(locales, (eachLocale) => {
                contentfulProjectService.setEntryField(newEntry, fieldName, fieldValue, eachLocale);
            });
        }

        contentfulProjectService.setEntryField(newEntry, fieldName, fieldValue, defaultLocale);
    });

    return duplicateEntry(defaultLocale, env, newEntry, duplicatableModels).then(contentfulProjectService.convertEntryToResponse)
        .catch(err => {
            logger.error('Contentful: Failed to create a page', {
                error: err.message || err,
                projectId: project.id,
                userId: user.id
            });
            throw err;
        });
}

async function duplicatePage(project, user, {pageId, srcProjectId, srcEnvironment, duplicatableModels = [], fields, schema, pageModel, locales, params}) {
    logger.debug('Contentful: duplicate page', { spaceId: srcProjectId, projectId: project.id, userId: user.id });
    const env = await getEnvironmentClientFromUserProjectAndSpaceId(user, project, srcProjectId, srcEnvironment);
    const defaultLocale = params.defaultLocale || contentfulProjectService.getLocale(project, srcProjectId);
    const getDefaultImage = makeDefaultImageGetter(project, user, srcProjectId, env);
    fields = updateSlugField(pageModel, fields);
    return duplicateEntry(defaultLocale, env, pageId, duplicatableModels, false, async entry => {
        const modelName = _.get(entry, 'sys.contentType.sys.id');
        const model = _.get(schema, modelName, {});
        const entryFields = _.assign(await getDefaultFieldsForCMSFromModel(model, schema, {getDefaultImage, duplicatableModels, locale: defaultLocale, createReferences: true}), fields);
        _.forEach(entryFields, (fieldValue, fieldName) => {
            const fieldModel = _.find(_.get(model, 'fields'), { name: fieldName });
            if (fieldModel.localized && locales) {
                return _.forEach(locales, eachLocale=>{
                    contentfulProjectService.setEntryField(entry, fieldName, fieldValue, eachLocale);
                });
            }

            contentfulProjectService.setEntryField(entry, fieldName, fieldValue, defaultLocale);
        });
    }).then(contentfulProjectService.convertEntryToResponse).catch(err => {
        logger.error('Contentful: Failed to duplicate a page', {
            error: err,
            projectId: project.id,
            userId: user.id,
            pageId
        });
        throw err;
    });
}

function fetchEntry({spaceId, accessToken, entryId, environment = 'master'}) {
    if (!spaceId || !entryId) {
        return Promise.resolve();
    }
    const endpoint = `spaces/${spaceId}/environments/${environment}/entries/${entryId}?access_token=${accessToken}`;
    // @fixme use contentful.createClient and getEntry() API
    return axios.get(`https://preview.contentful.com/${endpoint}`);
}

async function publishDrafts(project, user, { objects, type = 'objects', environment }) {
    if (_.isEmpty(objects)) {
        return Promise.resolve();
    }

    // @todo validate before actual publishing
    // const validationResult = await validateEntries(project, user, { objects, type, environment });
    // throw error with validationResult

    try {
        logger.debug('Contentful: publish drafts', { projectId: project.id, userId: user.id, objects, total: Object.values(objects).length});
        return iterateEntries(project, user, { objects, type, getEntriesQuery: { 'sys.archivedVersion[exists]' : false }, environment, callback: async ({ entry, spaceId }) => {
            try {
                await entry.publish();
                logger.debug('Contentful: entry published');
            } catch (err) {
                let errObject = null;
                try {
                    errObject = JSON.parse(err.message);
                } catch (e) {} // eslint-disable-line no-empty

                if (errObject?.status === 422) {
                    throw new errorUtils.ResponseError('ContentfulValidationError');
                }
                throw new errorUtils.ResponseError('PublishError');
            }
        }});
    } catch (err) {
        logger.error('Contentful: Failed to publish drafts', {
            error: err,
            projectId: project.id,
            userId: user.id
        });
        throw err;
    }
}

async function iterateEntries(project, user, { objects, type = 'objects', getEntriesQuery = {}, environment, callback }) {
    if (type === 'all') {
        return iterateAllEntries({ project, user, getEntriesQuery, environment, callback });
    } else {
        return iterateEntriesOfObjects({ project, user, objects, getEntriesQuery, environment, callback });
    }
}

async function iterateAllEntries({ project, user, getEntriesQuery, environment, callback }) {
    const accessToken = await getAccessTokenToProjectCMS(user, project);
    const spaces = contentfulProjectService.getProjectSpaces(project).map(({ spaceId }) => spaceId);
    return Promise.all(spaces.map(async spaceId => {
        const space = contentfulProjectService.getSpaceById(project, spaceId);
        const env = await getEnvironmentClientFromAccessTokenAndSpace(accessToken, space, environment);
        const entries = await env.getEntries(getEntriesQuery).then(response => response.items);
        const result = await iterateEntriesBySpace({ project, user, entries, spaceId, callback });
        return { [spaceId]: result };
    }));
}

async function iterateEntriesOfObjects({ project, user, objects, getEntriesQuery, environment, callback }) {
    const accessToken = await getAccessTokenToProjectCMS(user, project);
    const groupedObjects = _.groupBy(objects, 'srcProjectId');
    const spaces = Object.keys(groupedObjects);
    return Promise.all(spaces.map(async spaceId => {
        const space = contentfulProjectService.getSpaceById(project, spaceId);
        const env = await getEnvironmentClientFromAccessTokenAndSpace(accessToken, space, environment);
        const publishingObjects = _.get(groupedObjects, spaceId, []);
        const objectIds = publishingObjects.reduce((acc, { srcObjectId }) => {
            acc.push(srcObjectId);
            return acc;
        }, []);

        const result = await _.chunk(objectIds, 100).reduce(async (accumulatorPromise, objectIdsChunk) => {
            const accumEntries = await accumulatorPromise;
            const entries = await env.getEntries({
                'sys.id[in]': objectIdsChunk.join(','),
                ...getEntriesQuery
            }).then(response => response.items);

            const processedEntries = await iterateEntriesBySpace({ project, user, entries, spaceId, callback });
            return [...accumEntries, ...processedEntries];
        }, Promise.resolve([]));

        return {
            [spaceId]: result
        };
    }));
}

function iterateEntriesBySpace({ project, user, entries, spaceId, callback }) {
    const taskQueue = new TaskQueue({
        interval: 120,
        limit: 10
    });
    logger.debug('Contentful: iterateEntriesBySpace', { projectId: project.id, userId: user.id, spaceId, entriesLength: entries.length});
    return Promise.all(entries.map(entry => {
        return taskQueue.addTask(async () => {
            await callback({
                entry,
                spaceId
            });
            return entry;
        });
    }));
}

function adjustValue(entry, fieldPath, value, locale) {
    const oldValue = contentfulProjectService.getEntryField(entry, fieldPath, locale);
    if (_.isInteger(oldValue) &&
        !_.isInteger(value) &&
        !isNaN(value)) {

        return parseFloat(value);
    }
    return value;
}

async function modifyList({ entry, fieldPath, field, env, schema, locale, getDefaultImage, duplicatableModels }) {
    const { order, add, remove } = field;
    const arr = contentfulProjectService.getEntryField(entry, fieldPath, locale) || [];

    if (order) {
        const entryArr = arr.slice();
        const newEntryArr = order.map(newIndex => entryArr[newIndex]);
        contentfulProjectService.setEntryField(entry, fieldPath, newEntryArr, locale);
    } else if (add) {
        const { selectedModelName, selectedObjectId = null, values, position = arr.length } = field.add;
        const modelName = _.get(entry, 'sys.contentType.sys.id');
        const rootModel = _.get(schema, modelName);
        const fieldModel = _.find(rootModel.fields, ({ name }) => name === _.head(fieldPath));
        const { fieldType, model } = getFieldTypeAndModelForListItem({ fieldModel, selectedModelName, schema });

        // If we're trying to add an item to a list of images, there's no concept
        // of an empty value, so we retrieve the first existing image.
        if (fieldType === 'image') {
            const defaultImageId = await getDefaultImage();
            if (defaultImageId) {
                const link = getAssetLinkObject(defaultImageId);
                arr.splice(position, 0, link);
                contentfulProjectService.setEntryField(entry, fieldPath, arr, locale);
                return Promise.resolve();
            }
        }

        if (!selectedObjectId && !selectedModelName) {
            throw new Error('Expected to add value to list, but missing model name or object id');
        }

        if (fieldType === 'reference') {
            // @todo pass fields from 'field.add.pageModels' when stackbit.yaml for user project is standardized
            const objectPromise = selectedObjectId
                ? Promise.resolve({ sys: { id: selectedObjectId } })                    // link existing object
                : createObject({ modelName: model.name, schema, env, locale, getDefaultImage, duplicatableModels, fields: values });                 // create new object to link
            return objectPromise.then(object => {
                // @todo use contentfulProjectService.getNodeType
                const link = {
                    sys: {
                        type: 'Link',
                        linkType: 'Entry',
                        id: _.get(object, 'sys.id')
                    }
                };
                arr.splice(position, 0, link);
                contentfulProjectService.setEntryField(entry, fieldPath, arr, locale);
            });
        } else {
            const value = getFieldDefaultValue(fieldType);
            arr.splice(position, 0, value);
        }

        contentfulProjectService.setEntryField(entry, fieldPath, arr, locale);
    } else if (remove) {
        const { index } = remove;
        if (typeof index === 'number') {
            arr.splice(index, 1);
        }
        contentfulProjectService.setEntryField(entry, fieldPath, arr, locale);
    }

    return Promise.resolve();
}

function getFieldTypeAndModelForListItem({ fieldModel, selectedModelName, schema }) {
    const itemType = fieldModel.items.type;

    // Contentful has either reference or primitive, hence no need to check for object, model or other types
    if (itemType === 'reference') {
        return {
            fieldType: itemType,
            model: schema[selectedModelName ? selectedModelName : _.get(fieldModel, 'items.models.0')]
        };
    } else {
        // primitive
        return {
            fieldType: itemType,
            model:  fieldModel.items
        };
    }
}

function updateEntity({entityId, env, fields, getDefaultImage, duplicatableModels, project, retryAttempt = 0, schema, user}) {
    const { srcProjectId } = fields[0];
    const defaultLocale = contentfulProjectService.getLocale(project, srcProjectId);

    return env.getEntry(entityId).then(entry => {
        // mutate entry
        return Promise.all(fields.map(field => {
            const cmsSchema = schema[field.srcType][field.srcProjectId];
            const locale = field.locale || defaultLocale;
            return updateFieldInEntry({ entry, field, schema: cmsSchema, env, locale, getDefaultImage, duplicatableModels })
                .then(() => ({
                    locale,
                    spaceId: field.srcProjectId
                }));
        })).then(() => {
            return entry.update();
        });
    }).then(entry => {
        logger.debug(`Contentful: Entry ${entry.sys.id} updated.`);
        return entry;
    }).catch(err => {
        // If the error is `VersionMismatch`, it likely means we processed multiple
        // update requests concurrently and the entry we retrieved at the beginning
        // of the update process has since been updated elsewhere. In this case, we
        // retry the entire update procedure, as long as we haven't gone over the
        // maximum number of retries defined by `UPDATE_RETRY_COUNT`.
        if (err.name === 'VersionMismatch' && retryAttempt < UPDATE_RETRY_COUNT) {
            return updateEntity({entityId, env, fields, getDefaultImage, duplicatableModels, project, retryAttempt: retryAttempt + 1, schema, user});
        }

        logger.error('Contentful: Failed to update a page', {
            error: err,
            projectId: project.id,
            userId: user.id
        });
        throw err;
    });
}

async function updatePage(project, user, { changedFields, schema, duplicatableModels = [], environment }) {
    logger.debug('Contentful: update page', { projectId: project.id, userId: user.id});

    const fieldsByEntity = _.groupBy(changedFields, 'srcObjectId');

    await Promise.all(
        Object.keys(fieldsByEntity).map((entityId) => {
            const fields = fieldsByEntity[entityId];
            const { srcProjectId, srcEnvironment } = fields[0];

            return getEnvironmentClientFromUserProjectAndSpaceId(user, project, srcProjectId, srcEnvironment).then(env => {
                const getDefaultImage = makeDefaultImageGetter(project, user, srcProjectId, env);
                return updateEntity({entityId, env, fields, getDefaultImage, duplicatableModels, project, schema, user});
            });
        })
    );

    return validateEntries(project, user, { objects: changedFields, type: 'objects', environment });
}

function updateFieldInEntry({field, entry, schema, env, locale, getDefaultImage, duplicatableModels}) {
    const { value, fieldPath, order, add, remove, setObject, linkAsset, uploadAsset } = field;
    const modelName = _.get(entry, 'sys.contentType.sys.id');
    const model = _.get(schema, modelName);
    const fieldModel = getFieldModelForFieldPath(model, fieldPath);

    if (add || order) {
        return modifyList({ entry, fieldPath, field, env, schema, locale, getDefaultImage, duplicatableModels });
    } else if (remove) {
        if (fieldModel.type === 'list') {
            return modifyList({ entry, fieldPath, field, env, schema, locale, getDefaultImage, duplicatableModels });
        } else {
            const { key } = remove;
            contentfulProjectService.setEntryField(entry, key, null, locale);
        }
    } else if (setObject) {
        if (fieldModel.type === 'reference') {
            const {selectedObjectId, selectedModelName, values} = setObject;
            const objectPromise = selectedObjectId
                ? Promise.resolve({ sys: { id: selectedObjectId } })                    // link existing object
                : createObject({ modelName: selectedModelName, schema, env, locale, getDefaultImage, duplicatableModels, fields: values });                 // create new object to link
            return objectPromise.then(object => {
                const link = {
                    sys: {
                        type: 'Link',
                        linkType: 'Entry',
                        id: _.get(object, 'sys.id')
                    }
                };
                contentfulProjectService.setEntryField(entry, fieldPath, link, locale);
            });
        }
    } else if (linkAsset) {
        const assetLink = linkAsset.id ? getAssetLinkObject(linkAsset.id) : null;

        contentfulProjectService.setEntryField(entry, fieldPath, assetLink, locale);

        return Promise.resolve();
    } else if (uploadAsset && uploadAsset.url) {
        return uploadAssetFromURL({
            env,
            locale,
            name: uploadAsset.metadata.name,
            type: uploadAsset.metadata.type,
            url: uploadAsset.url,
        }).then((asset) => {
            const assetId = _.get(asset, 'sys.id');
            const assetLink = getAssetLinkObject(assetId);

            contentfulProjectService.setEntryField(entry, fieldPath, assetLink, locale);
        });
    } else if (typeof value !== 'undefined') {
        const adjustedValue = adjustValue(entry, fieldPath, value, locale);
        contentfulProjectService.setEntryField(entry, fieldPath, adjustedValue, locale);
        // TODO any field adjustments should be performed before calling updatePage based on content model
    } else {
        throw new Error(`Unrecognized field action: ${Object.keys(field).toString()}`);
    }

    return Promise.resolve();
}

function getFieldModelForFieldPath(model, fieldPath) {
    if (!fieldPath.length) {
        return model;
    }

    return _.find(model.fields, ({ name }) => name === _.head(fieldPath));
}

async function createObject({ fields = {}, schema, modelName, env, locale, getDefaultImage, duplicatableModels }) {
    const newEntry = {
        sys: {
            contentType: {
                sys: {
                    id: modelName
                }
            }
        }
    };

    const modelSchema = _.get(schema, modelName);
    const defaultFields = await getDefaultFieldsForCMSFromModel(modelSchema, schema, {getDefaultImage, duplicatableModels, locale, createReferences: false});

    const newFields = {
        ...defaultFields,
        ...fields
    };
    _.forEach(newFields, (value, fieldName) => {
        contentfulProjectService.setEntryField(newEntry, fieldName, value, locale);
    });

    return env.createEntry(modelName, newEntry);
}

async function hasAccess(project, user) {
    const spaces = contentfulProjectService.getProjectSpaces(project);
    const token = await getAccessTokenToProjectCMS(user, project);

    if (!token) {
        logger.debug('[contentful hasAccess] user does not have a CMS connection token');
        return Promise.resolve({
            hasConnection: false,
            hasPermissions: null
        });
    }

    logger.debug('[contentful hasAccess] user has CMS connection token');

    const client = contentful.createClient({ accessToken: token });

    return Promise.all(_.map(spaces, space => {
        const spaceId = space.spaceId;
        return client.getSpace(spaceId).then(space => {
            logger.debug(`[contentful hasAccess] user has access to space: ${spaceId}`);
            return true;
        }).catch(err => {
            logger.debug(`[contentful hasAccess] user does not have access to space: ${spaceId}`);
            return false;
        });
    })).then(results => {
        return {
            hasConnection: true,
            hasPermissions: _.every(results)
        };
    });
}

async function hasChanges(project, user, { objects, type = 'objects', environment }) {
    const validatedObjects = [];

    await iterateEntries(project, user, { objects, type, getEntriesQuery: { select: 'sys.id,sys.version,sys.publishedVersion' }, environment, callback: ({ entry, spaceId }) => {
        validatedObjects.push({
            srcObjectId: entry.sys.id,
            srcProjectId: spaceId,
            srcType: 'contentful',
            hasChanges: isChanged(entry) || isDraft(entry)
        });
        return Promise.resolve();
    }});

    const hasChanges = _.some(validatedObjects, ({ hasChanges }) => hasChanges);
    return {
        hasChanges,
        changedObjects: validatedObjects.filter(({ hasChanges }) => hasChanges)
    };
}

function isChanged(entity) {
    return entity.sys.publishedVersion &&
        entity.sys.version >= entity.sys.publishedVersion + 2;
}
function isDraft(entity) {
    return !entity.sys.publishedVersion;
}

function getDefaultFieldsForCMSFromModel(modelSchema, schema, {getDefaultImage, duplicatableModels, locale, createReferences = false} = {}) {
    const values = getDefaultFieldsFromModel(modelSchema, schema, 0, {processAsset: true, duplicatableModels, createReferences});
    const modelFields = _.get(modelSchema, 'fields');
    const resultObject = {};
    const promises = _.map(values, async (value, fieldName) => {
        const field = _.find(modelFields, { name: fieldName });
        if (field.type === 'richText') {
            return resultObject[fieldName] = {
                nodeType: 'document',
                data: {},
                content: convertDefaultReachTextToResponse(value)
            };
        }
        if (field.type === 'image') {
            // get first image from gallery
            // @todo improve logic for that case
            const defaultImageId = await getDefaultImage();
            return resultObject[fieldName] = {
                sys: {
                    type: 'Link',
                    linkType: 'Asset',
                    id: defaultImageId
                }
            };
        }
        if (field.type === 'reference' && value === 'new') {
            const referencedModelName = field.models[0];
            const referencedModelSchema = _.get(schema, referencedModelName);
            const defaultFields = await getDefaultFieldsForCMSFromModel(referencedModelSchema, schema, {getDefaultImage, duplicatableModels, locale, createReferences: false});
            const newEntry = {
                sys: {
                    contentType: {
                        sys: {
                            id: referencedModelName
                        }
                    }
                }
            };
            _.forEach(defaultFields, (value, fieldName) => {
                contentfulProjectService.setEntryField(newEntry, fieldName, value, locale);
            });
            return resultObject[fieldName] = newEntry;
        }
        return resultObject[fieldName] = value;
    });
    return Promise.all(promises).then(()=>resultObject);
}

function convertDefaultReachTextToResponse(value) {
    const regex = /<([^\s>]+)\s?[^>]*>(.*)(?:<\/\1)>/gm;
    const content = [];
    let match;

    while ((match = regex.exec(value)) !== null) {
        // This is necessary to avoid infinite loops with zero-width matches
        if (match.index === regex.lastIndex) {
            regex.lastIndex++;
        }

        content.push(contentfulProjectService.getNodeType({ tagName: match[1], value: match[2] }));
    }

    return content;
}

function uploadAssetFromURL({env, name, type, url, locale}) {
    return env.createAsset({
        fields: {
            title: {
                [locale]: name
            },
            file: {
                [locale]: {
                    fileName: name,
                    contentType: type,
                    upload: url
                }
            }
        }
    }).then(asset => {
        return asset.processForAllLocales();
    }).then(processedAsset => {
        return processedAsset.publish();
    });
}

function normalizeAssetObject(asset, locale) {
    const url = contentfulProjectService.getEntryField(asset, ['file', 'url'], locale);

    return {
        objectId: _.get(asset, 'sys.id'),
        url: (url && url.startsWith('//')) ? `https:${url}` : url,
        createdAt: _.get(asset, 'sys.createdAt'),
        fileName: contentfulProjectService.getEntryField(asset, 'file.fileName'.split('.'), locale),
        width: contentfulProjectService.getEntryField(asset, 'file.details.image.width'.split('.'), locale),
        height: contentfulProjectService.getEntryField(asset, 'file.details.image.height'.split('.'), locale),
        size: contentfulProjectService.getEntryField(asset, 'file.details.size'.split('.'), locale),
    };
}

function getAssetLinkObject(assetId) {
    return {
        sys: {
            type: 'Link',
            linkType: 'Asset',
            id: assetId
        }
    };
}

function getAssets(project, user, { pageId, pageSize, searchQuery, srcProjectId, srcEnvironment, env }) {
    const pageNumber = typeof pageId === 'number' ? pageId : 1;
    const parameters = {
        limit: pageSize,
        order: '-sys.updatedAt',
        skip: (pageNumber - 1) * pageSize,
        query: searchQuery
    };

    return Promise.resolve(env ? env : getEnvironmentClientFromUserProjectAndSpaceId(user, project, srcProjectId, srcEnvironment))
        .then(env => env.getAssets(parameters))
        .then(response => {
            const data = response.items.map(asset => normalizeAssetObject(asset, contentfulProjectService.getLocale(project, srcProjectId)));
            const hasNextPage = response.total > (pageNumber * pageSize);

            return {
                data,
                meta: {
                    nextPage: hasNextPage ? pageNumber + 1 : null
                }
            };
        });
}

function getEnvironments(project, user) {
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    return getSpaceClient(project, user, spaceId).then(space => {
        return space.getEnvironments().then(environments => {
            return _.uniq(_.get(environments, 'items', []).map(environment => environment.name));
        });
    });
}

function removeEnvironment(project, user, environment) {
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    return getSpaceClient(project, user, spaceId).then(space => {
        return space.getEnvironment(environment).then(contentfulEnvironment => {
            return contentfulEnvironment.delete();
        });
    });
}

function getEnvironmentAlias(project, user) {
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    return getSpaceClient(project, user, spaceId).then(space => {
        return space.getEnvironmentAliases().then(aliases => {
            if (!aliases || !aliases.items.length) {
                return null;
            }
            return {
                name: _.get(aliases, 'items[0].sys.id'),
                environment: _.get(aliases, 'items[0].environment.sys.id'),
            };
        });
    });
}

function createEnvironment(project, user, name, fromEnvironment='master') {
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    return getSpaceClient(project, user, spaceId).then(space => {
        return space.createEnvironmentWithId(name, {name}, fromEnvironment);
    });
}

async function createEnvironmentAlias(project, user, newEnvironmentId) {
    const accessToken = await getAccessTokenToProjectCMS(user, project);
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    return axios.put(`https://api.contentful.com/spaces/${spaceId}/optin/environment-aliases`, {
        newEnvironmentId
    }, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/vnd.contentful.management.v1+json'
        }
    }).then(response => {
        return {
            name: _.get(response, 'data.sys.aliases[0].sys.id'),
            environment: _.get(response, 'data.name'),
        };
    });
}

function updateEnvironmentAlias(project, user, toEnvironment) {
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    return getSpaceClient(project, user, spaceId).then(space => {
        return space.getEnvironmentAlias('master').then(alias => {
            if (!alias) {
                return Promise.reject();
            }
            _.set(alias, 'environment.sys.id', toEnvironment);
            return alias.update();
        });
    });
}

async function applyApiKeyToAllEnvironments(project, user, apiKeyId, deliveryApiKey) {
    const spaceId = _.get(project, 'deploymentData.contentful.spaceId');
    const space = await getSpaceClient(project, user, spaceId);
    if (!apiKeyId) {
        const apiKeys = await space.getApiKeys();
        const apiKeyObj = _.find(apiKeys.toPlainObject().items, apiKey => apiKey.sys.id === apiKeyId || apiKey.accessToken == deliveryApiKey);
        if (apiKeyObj) {
            apiKeyId = apiKeyObj.sys.id;
        }
    }
    if (!apiKeyId) {
        throw new Error('Contentful: API key not found');
    }
    const apiKeyObj = await space.getApiKey(apiKeyId);
    const environments = await space.getEnvironments();
    apiKeyObj.environments = environments.items.map(env => {
        return {
            sys: {
                id: _.get(env, 'sys.id'),
                type: 'Link',
                linkType: 'Environment'
            }
        };
    });
    await apiKeyObj.update();
}

function makeDefaultImageGetter(project, user, srcProjectId, env) {
    let defaultImageId = null;
    return async () => {
        if (defaultImageId) {
            return defaultImageId;
        }
        const assets = await getAssets(project, user, { pageSize: PAGE_SIZE_FOR_DEFAULT_IMAGE, srcProjectId, env });
        defaultImageId = _.get(assets, 'data[0].objectId');
        return defaultImageId;
    };
}

async function deleteObject(project, user, { srcEnvironment, srcObjectId, srcProjectId }) {
    logger.debug('Contentful: delete object', { spaceId: srcProjectId, projectId: project.id, userId: user.id });

    const env = await getEnvironmentClientFromUserProjectAndSpaceId(user, project, srcProjectId, srcEnvironment);

    try {
        const entry = await env.getEntry(srcObjectId);

        // Contentful won't let us delete a published entry, so if the entry is
        // published we must unpublish it first.
        if (_.get(entry, 'sys.publishedVersion')) {
            await entry.unpublish();
        }

        await entry.delete();
    } catch (err) {
        logger.error('Contentful: Failed to delete object', {
            srcObjectId,
            error: err,
            projectId: project.id,
            userId: user.id
        });

        throw err;
    }
}

async function uploadAssets(project, user, { srcEnvironment, srcProjectId, assets }) {
    const env = await getEnvironmentClientFromUserProjectAndSpaceId(user, project, srcProjectId, srcEnvironment);
    const locale = contentfulProjectService.getLocale(project, srcProjectId);
    const images = await Promise.all(assets.map((uploadAsset) => uploadAssetFromURL({
        env,
        locale,
        name: uploadAsset.metadata.name,
        type: uploadAsset.metadata.type,
        url: uploadAsset.url,
    })));
    return images.map((asset) => {
        return normalizeAssetObject(asset, locale);
    });
}

async function validateEntries(project, user, { objects, type = 'objects', environment }) {
    // supported only changing
    const isSupportedAction = (field) => field.value;
    const entries = [];
    const fieldsToValidate = objects.filter((object) => object.fieldPath ? isSupportedAction(object) : true);

    if (!fieldsToValidate.length) {
        return;
    }

    await iterateEntries(project, user, { objects: fieldsToValidate, type, environment, callback: ({ entry, spaceId }) => {
        entries.push({
            entry,
            srcProjectId: spaceId,
        });
        return Promise.resolve();
    }});

    const entriesBySpace = _.groupBy(entries, 'srcProjectId');

    const spacesErrors = await Promise.all(
        Object.keys(entriesBySpace).map(async (spaceId) => {
            const { srcEnvironment } = fieldsToValidate.find(field => field.srcProjectId === spaceId);
            const env = await getEnvironmentClientFromUserProjectAndSpaceId(user, project, spaceId, srcEnvironment);
            try {
                const createdBulkAction = await env.createValidateBulkAction({
                    entities: {
                        sys: { type: 'Array' },
                        items: entriesBySpace[spaceId].map(({ entry }) => ({
                            sys: {
                                type: entry.sys.contentType.sys.type,
                                linkType: entry.sys.type,
                                id: entry.sys.id
                            }
                        }))
                    }
                });
                const bulkAction = await createdBulkAction.waitProcessing({
                    retryCount: 3
                });
                // // BulkActionStatus - https://github.com/contentful/contentful-management.js/blob/d39d7dee12280c76a35fa165ba4a8557c63dfae9/lib/entities/bulk-action.ts#L23
                if (['inProgress', 'created'].includes(bulkAction.sys.status)) {
                    logger.warn('Contentful: Validate BulkAction skipped', {
                        srcObjectId: spaceId,
                        entries: entries,
                        projectId: project.id,
                        userId: user.id
                    });
                }

                if (bulkAction.sys.status === 'failed') {
                    logger.warn('Contentful: Validate BulkAction failed', {
                        srcObjectId: spaceId,
                        entries: entries,
                        projectId: project.id,
                        userId: user.id
                    });
                }
            } catch (e) {
                if (e.action?.error?.sys?.id === 'BulkActionFailed') {
                    const errors = e.action.error.details.errors;
                    const validationErrors = [];
                    for (const { error, entity } of errors) {
                        const { entry } = entries.find(({ entry }) => entry.sys.id === entity.sys.id);
                        const entryErrors = processEntryErrors({
                            errorObject: error,
                            entry,
                            locale: contentfulProjectService.getLocale(project, spaceId),
                            spaceId
                        });
                        validationErrors.push(...entryErrors);
                    }
                    return validationErrors;
                } else {
                    throw e;
                }
            }
        }));


    return {
        fieldsErrors: spacesErrors.reduce((acc, error) => {
            if (error) {
                acc.push(...error);
            }
            return acc;
        }, [])
    };
}


module.exports = {
    createSpace,
    getSpace,
    deleteObject,
    deleteSpace,
    createStackbitWebhook,
    applyStackbitWebhookToAllEnvironments,
    createApiKeys,
    applyApiKeyToAllEnvironments,
    createPersonalAccessToken,
    fetchEntry,
    createPage,
    duplicatePage,
    uploadAssets,
    createObject,
    publishDrafts,
    updatePage,
    hasAccess,
    hasChanges,
    getAssets,
    getEnvironments,
    removeEnvironment,
    getEnvironmentAlias,
    createEnvironment,
    createEnvironmentAlias,
    updateEnvironmentAlias
};
