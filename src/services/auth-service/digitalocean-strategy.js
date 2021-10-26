const DOStrategy = require('passport-digitalocean').Strategy;
const serverConfig = require('../../config').default.server;

const doConfig = require('../../config').default.digitalocean;
const DIGITALOCEAN_CALLBACK_URL = `${serverConfig.hostname}/auth/digitalocean/callback`;
const authStrategy = require('./auth-strategy');

module.exports = new DOStrategy(
    {
        clientID: doConfig.clientID,
        clientSecret: doConfig.clientSecret,
        userProfileURL: doConfig.userProfileURL,
        callbackURL: DIGITALOCEAN_CALLBACK_URL,
        passReqToCallback: true,
        scope: 'read write'
    }, authStrategy.bind(null, 'digitalocean', {mustAgreeTos:true, forceConnectionOnly: true}));

module.exports.userProfile = function(accesstoken, done) {
    this._oauth2.get(this._userProfileURL, accesstoken, (err, data) => {
        if (err) {
            return done(err);
        }
        try {
            data = JSON.parse(data);
        } catch (e) {
            return done(e);
        }

        const profile = {
            id: data.account?.uuid,
            emails: [{ value: data.account?.email }]
        };
        done(null, profile);
    });
};
