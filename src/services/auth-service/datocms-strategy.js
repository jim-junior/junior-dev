const OAuth2Strategy = require('passport-oauth2').Strategy;
const serverConfig = require('../../config').default.server;

const datocmsCredentials = require('../../config').default.datocms;
const DATOCMS_CALLBACK_URL = `${serverConfig.hostname}/auth/datocms/callback`;
const authStrategy = require('./auth-strategy');

module.exports = new OAuth2Strategy(
    {
        authorizationURL: datocmsCredentials.authorizationURL,
        tokenURL: datocmsCredentials.tokenURL,
        clientID: datocmsCredentials.clientId,
        clientSecret: datocmsCredentials.clientSecret,
        callbackURL: DATOCMS_CALLBACK_URL,
        passReqToCallback: true,
        scope: 'create_sites'
    }, authStrategy.bind(null, 'datocms', {mustAgreeTos:true}));
