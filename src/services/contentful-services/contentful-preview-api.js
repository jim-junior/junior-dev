const contentful = require('contentful');

const CONTENTFUL_PREVIEW_API_HOST = 'preview.contentful.com';

module.exports = {
    getEntries,
    syncSpace
};

function createPreviewApiClient(spaceId, environment, previewApiKey) {
    return contentful.createClient({
        space: spaceId,
        environment: environment,
        accessToken: previewApiKey,
        host: CONTENTFUL_PREVIEW_API_HOST
    });
}

function getEntries(spaceId, environment, previewApiKey, params={}) {
    return createPreviewApiClient(spaceId, environment, previewApiKey).getEntries({include: 5, ...params});
}

function syncSpace(spaceId, environment, previewApiKey, token) {
    const options = {
        initial: !token,
        nextSyncToken: token,
        resolveLinks: false
    };
    return createPreviewApiClient(spaceId, environment, previewApiKey).sync(options);
}
