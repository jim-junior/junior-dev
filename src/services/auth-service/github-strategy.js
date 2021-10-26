const GitHubStrategy = require('passport-github2').Strategy;
const githubCredentials = require('../../config').default.github;
const serverConfig = require('../../config').default.server;
const GITHUB_APP_CALLBACK_URL = `${serverConfig.hostname}/auth/github-app/callback`;
const authStrategy = require('./auth-strategy');

const appStrategy = new GitHubStrategy({
    clientID: githubCredentials.appClientId,
    clientSecret: githubCredentials.appClientSecret,
    callbackURL: GITHUB_APP_CALLBACK_URL,
    scope: 'user:email',
    passReqToCallback: true
}, authStrategy.bind(null, { auth: 'github', connection: 'github-app' }, {mustAgreeTos:true}));
appStrategy.name = 'github-app';

module.exports = appStrategy;
