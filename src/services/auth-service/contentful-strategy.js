const _ = require('lodash');
const OAuth2Strategy = require('passport-oauth2').Strategy;
const serverConfig = require('../../config').default.server;

const contentfulCredentials = require('../../config').default.contentful;
const CONTENTFUL_CALLBACK_URL = `${serverConfig.hostname}/auth/contentful/callback`;
const authStrategy = require('./auth-strategy');

module.exports = new OAuth2Strategy(
    {
        authorizationURL: contentfulCredentials.authorizationURL,
        tokenURL: contentfulCredentials.tokenURL,
        clientID: contentfulCredentials.clientId,
        clientSecret: contentfulCredentials.clientSecret,
        callbackURL: CONTENTFUL_CALLBACK_URL,
        passReqToCallback: true,
        scope: 'content_management_manage'
    },
    authStrategy.bind(null, 'contentful', { mustAgreeTos: true })
);

module.exports.userProfile = function(accesstoken, done) {
    this._oauth2.get(contentfulCredentials.profileURL, accesstoken, (err, data) => {
        if (err) {
            return done(err);
        }
        try {
            data = JSON.parse(data);
        } catch (e) {
            return done(e);
        }

        const displayName = `${_.get(data, 'firstName')} ${_.get(data, 'lastName')}`;
        const profile = {
            id: _.get(data, 'sys.id'),
            displayName: displayName,
            emails: [{ value: data.email }]
        };
        done(null, profile);
    });
};
