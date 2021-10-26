const passport = require('passport');
const path = require('path');
const queryString = require('query-string');
const analytics = require('../../services/analytics/analytics');
const _ = require('lodash');
const logger = require('../../services/logger');
const responseErrors = require('../../routers/response-errors');

module.exports = {
    baseAuthHandler: (type, req, res, next) => {
        if (req.user) {
            analytics.track('[Auth] Connect', {
                userId: req.user.id,
                type: type,
                projectId: analytics.projectIdFromRequest(req)
            }, req.user);
        } else {
            analytics.anonymousTrack('[Auth] Connect', {
                type: type
            }, req.cookies.ajs_anonymous_id);
        }

        let querystring = queryString.stringify(req.query);

        req.options = {
            state: querystring
        };
        if (type === 'sanity') {
            // sanity doesn't support state or query params
            req.options = {};
        }

        // azure requires params to be an object
        if (type === 'azure') {
            req.options = req.query;
            req.options.customState = querystring;
        }

        next();
    },
    genericAuth: (type, req, res, next) => {
        return passport.authenticate(type, req.options || {})(req, res, next);
    },
    genericAuthCallback: (type, req, res) => {
        analytics.identify(req.user, req);
        res.sendFile(path.join(__dirname, '../../services/auth-service/post-auth.html'));
        analytics.track('[Auth] Connect Success', {
            userId: req.user.id,
            type: type,
            projectId: analytics.projectIdFromRequest(req)
        }, req.user);
    },
    genericDisconnect: (req, res) => {
        const connectionType = _.get(req.params, 'connectionType');
        logger.debug(`Disconnect: removing ${connectionType} connection...`, connectionType);
        const connection = req.user.connections.find(con => con.type === connectionType);
        if (!connection) {
            logger.debug('Disconnect: No connection of this type found', connectionType);
            return res.status(404).send('Connection not found');
        }
        return req.user.removeConnection(connectionType).then((user) => {
            const connection = user.connections.find(con => con.type === connectionType);
            if (!connection) {
                logger.debug('Disconnect: successfully removed connection');
                return res.status(200).json(user);
            } else {
                logger.debug('Disconnect: failed to remove connection');
                return res.status(500).json(responseErrors.FailedToRemoveConnection);
            }
        }).catch(err => {
            return res.status(500).json(err);
        });
    }
};
