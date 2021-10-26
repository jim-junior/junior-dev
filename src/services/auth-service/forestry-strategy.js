const _ = require('lodash');
const OAuth2Strategy = require('passport-oauth2').Strategy;
const serverConfig = require('../../config').default.server;

const forestryCredentials = require('../../config').default.forestry;
const FORESTRY_CALLBACK_URL = `${serverConfig.hostname}/auth/forestry/callback`;
const authStrategy = require('./auth-strategy');
const {forestryAPI} = require('../forestry-services/forestry-service');

module.exports = new OAuth2Strategy(
    {
        authorizationURL: forestryCredentials.authorizationURL,
        tokenURL: forestryCredentials.tokenURL,
        clientID: forestryCredentials.clientId,
        clientSecret: forestryCredentials.clientSecret,
        callbackURL: FORESTRY_CALLBACK_URL,
        passReqToCallback: true
    }, authStrategy.bind(null, 'forestry', {mustAgreeTos:true}));

module.exports.userProfile = function(accesstoken, done) {
    forestryAPI(null, '/me', 'get', null, {}, accesstoken).then(data=>{
        const displayName = (_.get(data, 'first_name') || _.get(data, 'last_name')) ? `${_.get(data, 'first_name')} ${_.get(data, 'last_name')}`.trim() : null;
        const profile = {
            id: _.get(data, 'id'),
            displayName: displayName,
            emails: [{ value: data.email }]
        };
        done(null, profile);
    });
};
