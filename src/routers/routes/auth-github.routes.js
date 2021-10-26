const _ = require('lodash');
const path = require('path');
const queryString = require('query-string');
const GithubAppService = require('../../services/github-services/github-app');
const GithubService = require('../../services/github-services/github-repo');
const githubConfig = require('../../config').default.github;
const analytics = require('../../services/analytics/analytics');
const logger = require('../../services/logger');
const {getUserInstallations} = require('../../services/github-services/github-app');

module.exports = {
    githubCallback: (req, res) => {
        analytics.identify(req.user, req);
        const state = queryString.parse(req.query.state, {parseBooleans: true});

        if (state.install) {
            return getUserInstallations(req.user, req.user.githubAccessToken).then(installations => {
                if (!state.forceInstall && installations && installations.length && _.find(installations, {target_type: 'User'})) {
                    res.sendFile(path.join(__dirname, '../../services/auth-service/post-auth.html'));
                    analytics.track('Github Connect Success', {
                        userId: req.user.id,
                        projectId: analytics.projectIdFromRequest(req)
                    }, req.user);
                } else {
                    analytics.track('Github Connect Installing App', {
                        userId: req.user.id,
                        projectId: analytics.projectIdFromRequest(req)
                    }, req.user);
                    return res.redirect(githubConfig.appInstallUrl);
                }
            }).catch(err=>{
                logger.error('Github Connect Error: ', err);
                res.status(500).json(err);
            });
        }

        res.sendFile(path.join(__dirname, '../../services/auth-service/post-auth.html'));
        analytics.track('Github Connect Success', {
            userId: req.user.id,
            projectId: analytics.projectIdFromRequest(req)
        }, req.user);
    },
    githubInstallCallback: (req, res) => {
        analytics.identify(req.user, req);
        res.sendFile(path.join(__dirname, '../../services/auth-service/post-auth.html'));
        analytics.track('Github Connect App Installed', {
            userId: req.user.id,
            projectId: analytics.projectIdFromRequest(req)
        }, req.user);
    },
    githubInstallations: (req, res) => {
        const githubConnection = req.user.connections.find(con => con.type === 'github-app');
        if (!githubConnection) {
            logger.debug('Github: No github connection to refresh');
            return res.status(404).send('Connection not found');
        }

        return GithubAppService.getUserInstallations(req.user, githubConnection.accessToken).then(installations => {
            res.json(installations);
        }).catch(err => {
            logger.debug('Github: Error Getting Github Installations', { err: err?.message });
            return res.status(500).json(err);
        });
    },
    githubUser: (req, res) => {
        if (!req.user.githubAccessToken) {
            logger.debug('Github: No github connection found');
            return res.status(404).send('Connection not found');
        }
        return GithubService.getGithubUser(req.user.githubAccessToken).then(user => {
            res.json({
                id: user.id,
                username: user.login,
                profileUrl: user.html_url,
                avatarUrl: user.avatar_url
            });
        }).catch(err => {
            logger.debug('Github: Error Getting Github User', { err: err?.message });
            return res.status(500).json(err);
        });
    }
};
