
const _ = require('lodash');
const axios = require('axios');
const config = require('../../config').default;

const routerBaseURL = config.container.router.url;

function routerAPI(endpoint, baseUrl, method, data, headers, logger) {
    return axios({
        method: method,
        url: baseUrl + endpoint,
        headers,
        data: data
    }).then(response => {
        return response.data;
    }).catch((err) => {
        console.log(err);
        let error = err;
        if (err && err.response) {
            error = {
                code: err.response.status,
                data: err.response.data,
                message: _.get(err, 'response.data.error')
            };
        } else {
            error = {
                code: err.code,
                message: err.message
            };
        }
        if (logger) {
            logger.error('Router: Error:', {endpoint: endpoint, response: error});
        }
        throw error;
    });
}

function redirect(source, target) {
    return routerAPI('/api/routes/', routerBaseURL, 'POST', {
        settings: {
            mode: 'redirect'
        },
        source: new URL(source).host,
        target,
    });
}

function register(source, target) {
    return routerAPI('/api/routes/', routerBaseURL, 'POST', {
        source: new URL(source).host,
        target
    });
}

function unregister(source) {
    const hostname = new URL(source).host;
    return routerAPI(`/api/routes/${hostname}/`, routerBaseURL, 'DELETE');
}

module.exports = {
    register,
    unregister,
    redirect
};
