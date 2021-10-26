'use strict';

const _ = require('lodash');

let didInit = false;
let config = null;
let mongoPromise = null;
let logger = null;
let analytics = null;
let functions = null;
let passportInit = null;

let mongoConn = null;

const respond = (statusCode, body) => ({
    statusCode,
    body: JSON.stringify(body)
});

const isConnectionActive = () => {
    return mongoConn
        && mongoConn.readyState === _.get(mongoConn, 'states.connected', 1)
        && _.get(mongoConn, 'db.serverConfig.isConnected', () => false).apply(_.get(mongoConn, 'db.serverConfig'));
};

function init() {
    if (didInit) {
        return;
    }

    const refresh = require('passport-oauth2-refresh');
    const passport = require('passport');
    const devToStrategy = require('../services/auth-service/devto-strategy');
    passport.use('devto', devToStrategy);
    refresh.use('devto', devToStrategy);

    mongoPromise = require('../models/init-mongo');
    logger = require('../services/logger');
    analytics = require('../services/analytics/analytics');
    functions = require('./functions');

    didInit = true;
}

module.exports.pull = async (event, context, callback) => {
    context.callbackWaitsForEmptyEventLoop = false;

    config = await require('../config').loadConfig();

    init();

    const {body, pathParameters, queryStringParameters, warmup} = event;

    if (warmup) {
        return respond(200, {status: 'ok'});
    }

    const {projectId} = pathParameters;

    if (!body) {
        return respond(422, {status: 422, name: 'NoData', message: 'Request body is empty'});
    }

    let bodyData;
    try {
        bodyData = JSON.parse(body);
    } catch (err) {
        return respond(422, {status: 422, name: 'JSONParseError', message: 'Failed to parse JSON from body'});
    }

    if (!bodyData.apiKey) {
        return respond(401, {status: 401, name: 'APIKeyMissing', message: 'API key is missing'});
    }

    const params = _.assign(queryStringParameters, bodyData);
    const promise = isConnectionActive() ? Promise.resolve(mongoConn) : mongoPromise.init(true);
    return promise.then((conn) => {
        mongoConn = conn;
        logger.debug('Serverless: pulling for project', {projectId});

        return functions.pull(projectId, params)
            .then((pages) => {
                logger.debug(`Serverless: response ${pages.length} pages`);
                return respond(200, pages);
            })
            .catch((err) => {
                logger.error('Serverless: Stackbit Functions Pull Failed:', {projectId: projectId, error: err});
                const status = (err && err.status) || 500;
                const message = err && (err.message || err.toString());
                return respond(status, {status, name: 'GeneralError', message});
            })
            .then((res) => analytics.flush().then(() => res));
    });
};
