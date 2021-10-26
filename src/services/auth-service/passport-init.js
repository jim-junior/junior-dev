const passport = require('passport');
const User = require('../../models/user.model').default;
const githubStrategy = require('./github-strategy');
const googleStrategy = require('./google-stategy');
const contentfulStrategy = require('./contentful-strategy');
const netlifyStrategy = require('./netlify-strategy');
const azureStrategy = require('./azure-strategy');
const forestryStrategy = require('./forestry-strategy');
const datocmsStrategy = require('./datocms-strategy');
const sanityStrategy = require('./sanity-strategy');
const devToStrategy = require('./devto-strategy');
const DOStrategy = require('./digitalocean-strategy');
const widgetStrategy = require('./widget-strategy');
const refresh = require('passport-oauth2-refresh');

passport.use(User.createStrategy());
passport.use(githubStrategy);
passport.use(googleStrategy);
refresh.use('google', googleStrategy);
passport.use('contentful', contentfulStrategy);
passport.use('netlify', netlifyStrategy);
passport.use('azure', azureStrategy);
passport.use('datocms', datocmsStrategy);
passport.use('sanity', sanityStrategy);
passport.use('devto', devToStrategy);
refresh.use('devto', devToStrategy);
passport.use('forestry', forestryStrategy);
refresh.use('forestry', forestryStrategy);
passport.use('widget', widgetStrategy);
passport.use('digitalocean', DOStrategy);
refresh.use('digitalocean', DOStrategy);

const serializeUser = function () {
    return function (user, cb) {
        cb(null, user._id);
    };
};

const deserializeUser = function () {
    return (id, cb) => {
        User.findById(id, cb);
    };
};

passport.serializeUser(serializeUser());
passport.deserializeUser(deserializeUser());

module.exports = passport;
