const axios = require('axios');
const logger = require('../logger');
const { ResponseError } = require('../utils/error.utils');

const apiURL = 'https://api.digitalocean.com/v2/apps';

function doAPI(endpoint, { method, data, token } ) {
    const dataParam = ['get', 'delete'].includes(method) ? 'params' : 'data';
    const url = new URL(endpoint, endpoint ? `${apiURL}/` : apiURL);

    return axios({
        method: method,
        url: url.toString(),
        [dataParam]: data,
        headers: {
            'Authorization': 'Bearer ' + token
        }
    }).then(response => {
        return response.data;
    }).catch((error) => {
        logger.error('DigitalOcean: API Error:', {endpoint: endpoint, params: data, response: error});

        const status = error.response?.status;
        if (status === 429) {
            throw new ResponseError('DigitalOceanRateLimitError');
        } else if (status === 500) {
            // Retry isn't considered
            // From experienced cases it was down for too long, os retry will not help
            throw new ResponseError('DigitalOceanInternalServerError');
        } else if (status === 400) {
            throw new ResponseError('DigitalOceanAppConfigurationError');
        }

        throw error;
    });
}

function createNewApp(token, data) {
    return doAPI('',  {
        method: 'POST',
        data,
        token
    });
}

function fetchAppDeployments(token, appId) {
    return doAPI(`${appId}/deployments`,  {
        method: 'GET',
        token
    });
}

function getApp(token, appId) {
    return doAPI(`${appId}`,  {
        method: 'GET',
        token
    });
}

function deleteApp(token, appId) {
    return doAPI(`${appId}`,  {
        method: 'DELETE',
        token
    });
}

module.exports = {
    createNewApp,
    fetchAppDeployments,
    getApp,
    deleteApp
};
