const GoogleStrategy = require('passport-google-oauth').OAuth2Strategy;
const googleConfig = require('../../config').default.google;
const serverConfig = require('../../config').default.server;
const GOOGLE_APP_CALLBACK_URL = `${serverConfig.hostname}/auth/google/callback`;
const authStrategy = require('./auth-strategy');

module.exports = new GoogleStrategy({
    clientID: googleConfig.appClientId,
    clientSecret: googleConfig.appClientSecret,
    callbackURL: GOOGLE_APP_CALLBACK_URL,
    passReqToCallback: true,
    scope: googleConfig.defaultScopes
}, authStrategy.bind(null, 'google', { mustAgreeTos: true, addToUserGroup: true }));
