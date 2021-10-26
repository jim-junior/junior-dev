const _ = require('lodash');

const Project = require('../../../models/project.model').default;
const gitbasedCms = require('./gitbased');


class GitCms extends gitbasedCms.GitBasedCms {

    preBuild(project, user, previewBranchName, buildLogger) {
        return Project.updateDeploymentData(project._id, 'git', {
            connected: true,
            branch: previewBranchName
        });
    }

    preDeploy(project, user, buildLogger) {
        return Project.updateDeploymentData(project._id, 'git', {
            url: _.get(project, `deploymentData.${_.get(project, 'wizard.repository.id')}.url`)
        });
    }

    envForContainer(project, user, environmentName) {
        return {
            CMS_TYPE: _.get(project, 'wizard.cms.id')
        };
    }
}

module.exports = new GitCms();
