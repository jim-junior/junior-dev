const _ = require('lodash');
const OAuth2Strategy = require('passport-oauth2').Strategy;
const serverConfig = require('../../config').default.server;

const devtoCredentials = require('../../config').default.devto;
const DEVTO_CALLBACK_URL = `${serverConfig.hostname}/auth/devto/callback`;
const authStrategy = require('./auth-strategy');
const {apiFetch} = require('../devto-services/devto-service');

module.exports = new OAuth2Strategy(
    {
        authorizationURL: devtoCredentials.authorizationURL,
        tokenURL: devtoCredentials.tokenURL,
        clientID: devtoCredentials.clientId,
        clientSecret: devtoCredentials.clientSecret,
        callbackURL: DEVTO_CALLBACK_URL,
        passReqToCallback: true,
        scope: 'public'
    }, authStrategy.bind(null, 'devto', {mustAgreeTos:true, forceConnectionOnly: true}));

module.exports.userProfile = function(accesstoken, done) {
    apiFetch('users/me', accesstoken, null, 'get').then(data=>{
        const displayName = _.get(data, 'name');
        const profile = {
            id: _.get(data, 'id'),
            displayName: displayName,
            username: data.username,
            emails: null                   // devto doesn't use emails :(
        };
        done(null, profile);
    });
};
