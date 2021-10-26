const NetlifyStrategy = require('passport-netlify').Strategy;
const serverConfig = require('../../config').default.server;

const netlifyCredentials = require('../../config').default.netlify;
const NETLIFY_CALLBACK_URL = `${serverConfig.hostname}/auth/netlify/callback`;
const authStrategy = require('./auth-strategy');

module.exports = new NetlifyStrategy(
    {
        clientID: netlifyCredentials.clientId,
        clientSecret: netlifyCredentials.clientSecret,
        callbackURL: NETLIFY_CALLBACK_URL,
        passReqToCallback: true
    }, authStrategy.bind(null, 'netlify', {mustAgreeTos:true}));
