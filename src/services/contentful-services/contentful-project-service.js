const _ = require('lodash');
const Project = require('../../models/project.model').default;
const logger = require('../logger');
const ResponseErrors = require('../../routers/response-errors');

module.exports = {
    addSpaceToProject: (project, space, apiKeys, manageKey, isMulti) => {
        const spaceId = _.get(space, 'sys.id');
        const newSpace = {
            spaceId: spaceId,
            spaceName: space.name,
            deliveryApiKey: apiKeys.deliveryApiKey,
            previewApiKey: apiKeys.previewApiKey,
            apiKeyId: apiKeys.apiKeyId,
            manageKey: manageKey.token,
            url: `https://app.contentful.com/spaces/${spaceId}/entries`
        };

        if (!isMulti) {
            return Project.updateDeploymentData(project._id, 'contentful', newSpace);
        } else {
            const spaces = [...(_.get(project, 'deploymentData.contentful.spaces', []))];
            const foundSpace = _.find(spaces, {spaceId: spaceId});
            if (foundSpace) {
                _.assign(foundSpace, newSpace);
            } else {
                spaces.push(newSpace);
            }

            return Project.updateDeploymentData(project._id, 'contentful', {spaces: spaces});
        }
    },
    getProjectSpaces:(project) => {
        const spaces = _.get(project, 'deploymentData.contentful.spaces');
        if (spaces && spaces.length) {
            return spaces;
        }
        if (_.get(project, 'deploymentData.contentful.spaceId')) {
            return [_.get(project, 'deploymentData.contentful')];
        }

        return [];
    },
    getSpaceById,
    getNodeType,
    setEntryField,
    getEntryField,
    getEntryFieldPath,
    convertEntryToResponse,
    getLocale
};

function getSpaceById(project, spaceId) {
    if (_.get(project, 'deploymentData.contentful.spaces.length')) {
        return _.find(_.get(project, 'deploymentData.contentful.spaces'), {spaceId});
    } else if (_.get(project, 'deploymentData.contentful.spaceId') === spaceId) {
        return _.get(project, 'deploymentData.contentful');
    }

    return null;
}

function getNodeType({ tagName, value }) {
    const EmptyNodeData = {};
    let content = [];

    // @todo add more from https://github.com/contentful/rich-text/blob/32993445d5333368fce63bb09102588783542310/packages/rich-text-types/src/blocks.ts#L4
    // @todo and from from https://github.com/contentful/rich-text/blob/32993445d5333368fce63bb09102588783542310/packages/rich-text-types/src/nodeTypes.ts#L1
    switch(tagName) {
    case 'h1':
        content.push(getNodeType({ value }));

        return {
            nodeType: 'heading-1',
            data: EmptyNodeData,
            content
        };
    case 'p':
        content.push(getNodeType({ value }));

        return {
            nodeType: 'paragraph',
            data: EmptyNodeData,
            content
        };
    default:
        return {
            data: {},
            marks: [],
            value: value,
            nodeType: 'text'
        };
    }
}


function getEntryFieldPath(fieldPath, locale) {
    if (!locale) {
        throw new Error(`Locale is missed for fieldPath: ${fieldPath}`);
    }
    if (_.isArray(fieldPath) && _.size(fieldPath) > 1) {
        return _.concat('fields', _.head(fieldPath), locale, _.tail(fieldPath));
    } else {
        return _.concat('fields', fieldPath, locale);
    }
}

function setEntryField(entry, fieldPath, value, locale) {
    // When `value` is `null`, it means we're unsetting a field entirely,
    // which means setting `null` at the root of the field and not inside
    // a locale object.
    //
    // Correct:     {"field": null}
    // Incorrect:   {"field": {"en-US": null}}
    if (value === null) {
        _.set(entry, _.concat('fields', fieldPath), null);
    } else {
        _.set(entry, getEntryFieldPath(fieldPath, locale), value);
    }
}

function getEntryField(entry, fieldPath, locale) {
    return _.get(entry, getEntryFieldPath(fieldPath, locale));
}

function convertEntryToResponse(entry) {
    const spaceId = _.get(entry, 'sys.space.sys.id');
    const entryId = _.get(entry, 'sys.id');
    return {
        url: `https://app.contentful.com/spaces/${spaceId}/entries/${entryId}`,
        id: entryId,
        srcProjectId: spaceId
    };
}

function getLocale(project, spaceId) {
    const space = getSpaceById(project, spaceId);
    return _.get(space, 'locale', 'en-US');
}
