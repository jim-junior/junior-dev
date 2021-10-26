const _ = require('lodash');
const Project = require('../models/project.model').default;

// 0. query for sharedContainers and for client containers which running old container
// 1. read branch info from the CMS and set it to the deploymentData.container (env) level as `branch`.
// In case it's git based cmses, branch in the cms is preview branch and publish branch is: `envName`, `repository default branch` or `master` (default for previous projects)
// For api based cmses, both branch & publishBranch are: `envName`, `repository default branch` or `master` if not exists
// 2. For imported containers branch & publish branch already in place, no need to do anything
// 3. Remove `publishBranch` `previewBranch` from container.branchStatus
// 4. Rename container.branch to container.previewBranch

const GIT_CMS = ['git', 'forestry', 'netlifycms'];
const $QUERY = { '$or': [{'wizard.deployment.id': 'container' }, {'wizard.container.id': 'sharedContainer'} ] };

module.exports = {
    async up(db, client) {
        const projects = await Project.find({ $query: $QUERY, $maxTimeMS: 60000 });
        return _.reduce(projects, async (previousPromise, project) => {
            await previousPromise;

            const isImported = _.get(project, 'wizard.container.settings.imported');
            const cmsId = _.get(project, 'wizard.cms.id');
            const repoId = _.get(project, 'wizard.repository.id');
            const isGitBased = GIT_CMS.includes(cmsId);
            const defaultBranch = _.get(project, `deploymentData.${repoId}.defaultBranch`, 'master');

            let $unset = {};
            let $set = {};

            _.keys(project.environments).concat(null).forEach(environmentName => {
                const deploymentDataKey = environmentName ? `environments.${environmentName}` : 'deploymentData';
                const deploymentData = _.get(project, deploymentDataKey);

                $unset[`${deploymentDataKey}.container.branchStatus.previewBranch`] = 1;
                $unset[`${deploymentDataKey}.container.branchStatus.publishBranch`] = 1;

                if (isImported) {
                    $set[`${deploymentDataKey}.container.previewBranch`] = _.get(deploymentData, 'container.branch');
                } else {
                    const publishBranch = environmentName || defaultBranch;
                    const previewBranch = isGitBased ? _.get(deploymentData, `${cmsId}.branch`, 'preview') : publishBranch;
                    $set[`${deploymentDataKey}.container.previewBranch`] = previewBranch;
                    $set[`${deploymentDataKey}.container.publishBranch`] = publishBranch;
                }

                $unset[`${deploymentDataKey}.container.branch`] = 1;
            });

            return Project.update(
                { '_id' : project._id },
                { $set, $unset }
            );
        }, Promise.resolve());
    },

    async down(db, client) {
    }
};
