const passport = require('passport');
const path = require('path');
const googleConfig = require('../../config').default.google;
const analytics = require('../../services/analytics/analytics');
const logger = require('../../services/logger');
const refresh = require('passport-oauth2-refresh');
const _ = require('lodash');

module.exports = {
    googleAuth: (req, res, next) => {
        const allowedScopes = googleConfig.allowedScopes;
        const {scope: queryScopes = []} = req.query;
        const requestedScopes = Array.isArray(queryScopes) ? queryScopes : [queryScopes];
        const scopes = requestedScopes.filter(scope => allowedScopes.includes(scope)).concat(googleConfig.defaultScopes);

        const options = {
            ...req.options,
            scope: scopes,
            includeGrantedScopes: true,
            accessType: 'offline',
            prompt: 'consent'
        };

        return passport.authenticate('google', options)(req, res, next);
    },
    googleRefresh: (req, res) => {
        logger.debug('Google: refreshing access token');
        const googleConnection = req.user.connections.find(con => con.type === 'google');
        if (!googleConnection) {
            logger.debug('Google: No google connection to refresh');
            return res.status(404).send('Connection not found');
        }

        return refresh.requestNewAccessToken('google', googleConnection.refreshToken, (err, accessToken, refreshToken) => {
            if (err) {
                return req.user.removeConnection('google').then(() => {
                    logger.debug('Google: removed access token, cannot refresh');
                    return res.status(500).json(err);
                });
            }
            return req.user.addConnection('google', {accessToken, refreshToken}).then(() => {
                logger.debug('Google: Access token refreshed');
                return res.json({status: 'ok'});
            });
        });
    }
};
