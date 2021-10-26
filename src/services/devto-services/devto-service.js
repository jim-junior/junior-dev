const _ = require('lodash');
const axios = require('axios');
const refresh = require('passport-oauth2-refresh');

const logger = require('../../services/logger');

//TODO move to external library once API is set

const MAX_PAGES = 1000;

const Errors = {
    Unauthorized: 'Unauthorized',
    RateLimited: 'RateLimited'
};

function apiFetch(endpoint, token, data, method='get') {
    return axios({
        method: method,
        url: `https://dev.to/api/${endpoint}`,
        data,
        headers: {
            Authorization: `Bearer ${token}`
        }
    }).then(resp => {
        return resp.data;
    }).catch(err => {
        const statusCode = _.get(err, 'response.status');
        logger.warn('[devto] api returned error', {endpoint, statusCode});
        if (statusCode === 401) {
            throw Errors.Unauthorized;
        } else if (statusCode === 429) {
            throw Errors.RateLimited;
        }
        throw err;
    });
}

function doRefreshToken(user, refreshToken) {
    logger.debug('DEV: Refreshing access token');
    return new Promise((resolve, reject) => {
        refresh.requestNewAccessToken('devto', refreshToken, (refreshErr, accessToken, refreshToken) => {
            if (refreshErr || !accessToken) {
                return reject(refreshErr);
            }
            resolve(user.addConnection('devto', {accessToken, refreshToken}).then(() => {
                logger.debug('DEV: Access token refreshed');
            }));
        });
    });
}

function fetchWithUser(user, endpoint, data, method='get', retry=false) {
    const connection = _.find(user.connections, {type: 'devto'});
    const accessToken = _.get(connection, 'accessToken');
    if (!accessToken) {
        throw {status: 500, name: 'GeneralError', message: 'DEV token not provided for user'};
    }

    return apiFetch(endpoint, accessToken, data, method).catch(err => {
        if (!retry && err === Errors.Unauthorized) {
            const refreshToken = _.get(connection, 'refreshToken');
            if (!refreshToken) {
                throw {status: 500, name: 'GeneralError', message: 'DEV refresh token not available'};
            }
            return doRefreshToken(user, refreshToken).then(() => {
                return fetchWithUser(user, endpoint, data, method, true);
            });
        } else if (!retry && err == Errors.RateLimited) {
            return new Promise((resolve, reject) => {
                setTimeout(() => {
                    resolve(fetchWithUser(user, endpoint, data, method, true));
                }, 2000);
            });
        }
        throw err;
    });
}

async function getArticles(user) {
    let articles = [];
    let page = 1;
    while (page < MAX_PAGES) {
        const pageArticles = await fetchWithUser(user, `articles/me?page=${page}&per_page=1000`, {});
        page++;
        if (!_.isEmpty(pageArticles) && _.isArray(pageArticles)) {
            articles.push(...pageArticles);
        } else {
            break;
        }
    }
    logger.debug('DEV: Got articles', {pages: page, articles: articles.length});
    return _.uniqBy(articles, (article) => article.id);
}

async function getUser(user) {
    return fetchWithUser(user, 'users/me');
}

async function registerWebhook(user, url) {
    const data = await fetchWithUser(user, 'webhooks', {
        webhook_endpoint: {
            target_url: url,
            source: 'DEV',
            events: ['article_created', 'article_updated', 'article_destroyed']
        }
    }, 'post');

    if (!_.isEmpty(data)) {
        return data.id;
    }
    return null;
}

async function unregisterWebhook(user, webhookId) {
    return fetchWithUser(user, `webhooks/${webhookId}`, {}, 'delete');
}

async function deleteProject(project, user) {
    const webhookId = _.get(project, 'deploymentData.devto.webhookId');
    if (webhookId) {
        return unregisterWebhook(user, webhookId);
    }
    return null;
}

module.exports = {
    getArticles,
    getUser,
    registerWebhook,
    deleteProject,
    Errors,
    apiFetch
};
