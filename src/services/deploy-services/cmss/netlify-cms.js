const netlifycmsService = require('../../netlify-services/netlifycms-service');
const Project = require('../../../models/project.model').default;
const _ = require('lodash');
const config = require('../../../config').default;
const analytics = require('../../analytics/analytics');
const gitbasedCms = require('./gitbased');


class NetlifyCms extends gitbasedCms.GitBasedCms {

    preBuild(project, user, previewBranchName, buildLogger) {
        return Project.updateDeploymentData(project._id, _.get(project, 'wizard.cms.id'), {
            connected: true,
            branch: previewBranchName
        });
    }

    preDeploy(project, user, buildLogger) {
        return Project.updateDeploymentData(project._id, _.get(project, 'wizard.cms.id'), {
            url: _.get(project, `deploymentData.${_.get(project, 'wizard.repository.id')}.url`)
        });
    }

    postDeployConnect(project, user, buildLogger) {
        if (_.get(project, 'deploymentData.netlifycms.inviteSent')) {
            buildLogger.debug('NetlifyCMS: Skipping connect netlifycms, invite already sent');
            return Promise.resolve(project);
        }

        if (!_.get(project, 'deploymentData.netlify.id')) {
            buildLogger.error('NetlifyCMS: Cannot connect NetlifyCMS to a project without a netlify site id');
            return Promise.resolve(project);
        }
        const {githubAccessToken} = user;
        const netlifyAccessToken = _.get(project, 'deploymentData.netlify.anonFlow') ? config.netlify.anonAccessToken : user.netlifyAccessToken;

        buildLogger.debug('NetlifyCMS: Enabling identity service');
        return netlifycmsService.enableIdentityForNetlifyCMS(project, user, netlifyAccessToken, githubAccessToken, buildLogger).then(() => {
            return Project.updateDeploymentData(project._id, 'netlifycms', {
                connected: false,
                inviteSent: true
            });
        }).then(() => {
            // additional build is required after enabling identity
            return require('../deployments').callDeploymentMethodForProject('triggerBuild', project, user);
        }).catch(err => {
            buildLogger.error('NetlifyCMS: failed to connect netlifycms', {error: err});
            throw err;
        });
    }

    onWebhook(project, user, req) {
        if (_.get(req, 'body.event') === 'signup') {
            analytics.track('NetlifyCMS: Connected NetlifyCMS user', {projectId: project.id, userId: user.id}, user);
            return Project.updateDeploymentData(project.id, 'netlifycms', {
                connected: true,
                url: `${project.siteUrl}/admin`
            });
        }

        return Promise.resolve(project);
    }

    envForContainer(project, user, environmentName) {
        return {
            CMS_TYPE: _.get(project, 'wizard.cms.id')
        };
    }

    contextForBuild(project) {
        const cmdArgs = [];
        if (_.get(project, 'wizard.container.id') === 'sharedContainer') {
            const branch = project.getDeploymentData('netlifycms.branch', null, project.getDefaultBranch());
            cmdArgs.push(`--netlifycms-branch=${branch}`);
        }
        return cmdArgs;
    }
}

module.exports = new NetlifyCms();
