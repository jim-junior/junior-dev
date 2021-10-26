const axios = require('axios');
const _ = require('lodash');
const FormData = require('form-data');
const logger = require('../logger');

const FAILED_TO_LOGIN = 'Failed to Login';

function forestryAPI(ssoName, endpoint, method, data, headers, token) {
    return axios({
        method: method,
        url: `https://${ssoName || 'app'}.forestry.io${endpoint}`,
        data: data,
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            ...headers
        }
    }).then(response => {
        if (typeof response.data === 'string' && method.toLowerCase() !== 'delete') {
            console.log(response);
            throw { code: 401, message: FAILED_TO_LOGIN };
        }
        return response.data;
    }).catch((err) => {
        let error = err;

        if (err && err.response) {
            error = {
                code: err.response.status,
                data: err.response.data
            };
            if (typeof _.get(error, 'data.error') === 'string') {
                error.message = error.data.error;
            }
        } else if (err.message) {
            error = {
                code: err.code,
                message: err.message
            };
        }

        logger.error('Forestry: Error:', {endpoint: endpoint, params: data, response: error, err: err.toString()});
        throw error;
    });
}

function getSsoName(project) {
    return _.get(project, 'deploymentData.forestry.ssoName', 'app');
}

function createPublicKeyForGithub(project, githubUser, githubAccessToken, token) {
    let sshURL = _.get(project, 'deploymentData.github.sshURL');

    return forestryAPI(getSsoName(project), '/gh', 'post', {
        'name': '',
        'username': githubUser.login,
        'token': githubAccessToken,
        'url': sshURL,
        'scope': 'scope_private'
    }, {}, token);
}

const VERSION_MAP = {
    'hugo': '0.47'
};

function createSite(project, githubUser, githubAccessToken, token, repoId, branch='master') {
    let engine = _.get(project, 'wizard.ssg.id');
    let repoProvider = _.get(project, 'wizard.repository.id');
    let sshURL = _.get(project, 'deploymentData.github.sshURL');

    if (!['hugo','jekyll','gatsby'].includes(engine)) {
        engine = 'gatsby'; // for custom ssgs like eleventy
    }

    let data = {
        'repoName': '',
        'type': 'import',
        'engine': {'name': engine, 'version': VERSION_MAP[engine] || ''},
        'source': {
            'connection': {
                'username': githubUser.login,
                'token': githubAccessToken,
                'uid': githubUser.id,
                'provider': repoProvider,
                'scope': 'scope_private'
            },
            'repo': sshURL,
            'branch': branch
        },
        'configPath': '',
        'organization': '',
        'guests': [],
        'repository': repoId,
        'template': null
    };
    return forestryAPI(getSsoName(project), '/sites', 'post', data, {}, token);
}

function deleteSite(project, token) {
    const id = _.get(project, 'deploymentData.forestry.siteId');
    return forestryAPI(getSsoName(project), `/sites/${id}`, 'delete', null, {}, token);
}

function reuploadSite(project, branch, token) {
    const id = _.get(project, 'deploymentData.forestry.siteId');
    return forestryAPI(getSsoName(project), `/sites/${id}/reupload`, 'post', {
        git_branch: branch, 
        skip_content: false
    }, {}, token);
}

function importSite(project, githubUser, githubAccessToken, token, branch) {
    return createPublicKeyForGithub(project, githubUser, githubAccessToken, token).then((result) => {
        return createSite(project, githubUser, githubAccessToken, token, result.public_id, branch);
    });
}

async function uploadAsset(project, user, url, filename, token) {
    const imageResponse = await axios({
        responseType: 'stream',
        url
    });

    const siteId = _.get(project, 'deploymentData.forestry.siteId');
    const formData = new FormData();
    formData.append('file', imageResponse.data, filename);

    const response = await forestryAPI(getSsoName(project), `/sites/${siteId}/media`, 'post', formData, formData.getHeaders(), token);

    return { objectId: response.servedFromFrontMatter };
}

async function listAssets(project, user, filter, token) {
    const siteId = _.get(project, 'deploymentData.forestry.siteId');

    const searchTerm = _.get(filter, 'searchQuery', '');
    const pageSize = _.get(filter, 'pageSize', 20);
    const pageId = _.get(filter, 'pageId', null);

    return forestryAPI(getSsoName(project), '/graphql', 'post', {
        operationName: 'MediaIndex',
        variables: {
            searchTerm,
            id: siteId,
            limit: pageSize,
            offset: pageId
        },
        query: `
            query MediaIndex($id: String!, $searchTerm: String, $limit: Int, $offset: String) {
              site(id: $id) {
                id
                mediaCollection(searchTerm: $searchTerm, limit: $limit, offset: $offset) {
                  nextCursor
                  contents {
                    id
                    url
                    servedFrom
                    servedFromFrontMatter
                    filename
                    dirname
                    thumb160
                    thumb512
                  }
                }
              }
            }`
    }, {}, token).then(response => response.data.site.mediaCollection);
}

function updateChecklist(project, token) {
    const siteId = _.get(project, 'deploymentData.forestry.siteId');
    return forestryAPI(getSsoName(project), '/graphql', 'post', {
        operationName: 'UpdateCheckList',
        variables: {
            input: {
                id: siteId,
                setupPreviewCommands: true,
                setupBuildCommands: true,
                addSections: true,
                importRepo: true,
                setupMedia: true,
                dismissCheckList: true
            }
        },
        query: 'mutation UpdateCheckList($input: UpdateCheckListInput!) {\n  updateCheckList(input: $input) {\n    site {\n      id\n      checkList {\n        importRepo\n        addSections\n        setupMedia\n        setupPreviewCommands\n        setupBuildCommands\n        dismissCheckList\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n'
    }, {}, token);
}

function getMediaProviders(project, user, token) {
    const siteId = _.get(project, 'deploymentData.forestry.siteId');
    return forestryAPI(getSsoName(project), `/sites/${siteId}/media_providers`, 'get', {}, {}, token);
}

module.exports = {
    importSite,
    reuploadSite,
    updateChecklist,
    deleteSite,
    uploadAsset,
    listAssets,
    forestryAPI,
    getMediaProviders,
    FAILED_TO_LOGIN
};
