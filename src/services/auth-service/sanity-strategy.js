const SanityStrategy = require('passport-sanity').Strategy;
const serverConfig = require('../../config').default.server;

const sanityCredentials = require('../../config').default.sanity;
const SANITY_CALLBACK_URL = `${serverConfig.hostname}/auth/sanity/callback`;
const authStrategy = require('./auth-strategy');

module.exports = new SanityStrategy(
    {
        clientID: sanityCredentials.clientId,
        clientSecret: sanityCredentials.clientSecret,
        callbackURL: SANITY_CALLBACK_URL,
        state: {},
        passReqToCallback: true
    }, authStrategy.bind(null, 'sanity', {mustAgreeTos:true, alwaysAllowConnectionOnly: true}));
