const config = require('../../config').default;
const _ = require('lodash');
const {netlifyAPI} = require('./netlify-service');

function createNetlifyIdentityHook(project, siteId, identity_instance_id, netlifyToken) {
    let webhookHostname = config.server.webhookHostname;
    return netlifyAPI(`/sites/${siteId}/identity/${identity_instance_id}`, 'put', {
        'webhook': {
            'events': ['signup'],
            'secret': '',
            'url': `${webhookHostname}/project/${project.id}/webhook/netlifycms`
        }
    }, netlifyToken);
}

function enableIdentityForSite(siteId, netlifyToken) {
    return netlifyAPI(`/sites/${siteId}/identity`, 'post', {disable_signup: true}, netlifyToken);
}

function inviteUserToNetlifyCMS(siteId, identity_instance_id, email, netlifyToken) {
    return netlifyAPI(`/sites/${siteId}/identity/${identity_instance_id}/users/invite`, 'post', {invites: [{'email': email}]}, netlifyToken);
}

function enableGitGatewayForSite(siteId, repoFullName, netlifyToken, githubToken) {
    return netlifyAPI(`/sites/${siteId}/services/git/instances`, 'post', {
        github: {'access_token': githubToken, 'repo': repoFullName}
    }, netlifyToken);
}

function enableIdentityForNetlifyCMS(project, user, netlifyToken, githubToken, buildLogger) {
    const siteId = _.get(project, 'deploymentData.netlify.id');
    const repoFullName = _.get(project, 'deploymentData.github.fullName');
    buildLogger.debug('Netlify: enabling NetlifyCMS Identity');
    return enableIdentityForSite(siteId, netlifyToken).then(identityService => {
        return enableGitGatewayForSite(siteId, repoFullName, netlifyToken, githubToken).then(() => {
            buildLogger.debug('Netlify: creating identity hook', {email: user.email});
            return createNetlifyIdentityHook(project, siteId, identityService.id, netlifyToken).catch((err) => {
                buildLogger.error(`Netlify: couldn't create identity hook (${err})`);
            }).finally(() => {
                buildLogger.debug('Netlify: inviting user to netlifyCMS', {email: user.email});
                return inviteUserToNetlifyCMS(siteId, identityService.id, user.email, netlifyToken);
            });
        });
    });
}

module.exports = {
    enableIdentityForNetlifyCMS
};
