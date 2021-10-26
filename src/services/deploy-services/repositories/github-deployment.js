const _ = require('lodash');
const githubRepo = require('../../github-services/github-repo');
const gitService = require('../git-service');
const errorUtils = require('../../utils/error.utils');
const Project = require('../../../models/project.model').default;
const User = require('../../../models/user.model').default;
const ResponseErrors = require('../../../routers/response-errors');
const logger = require('../../logger');
const analytics = require('../../analytics/analytics');
const config = require('../../../config').default;
const {
    determineCommitSource,
    decodeRepoUrl
} = require('../../github-services/github-utils');
const { withRetry } = require('../../utils/code.utils');

const getGithubAccessToken = (project, user) => {
    let githubAccessToken = _.get(user, 'githubAccessToken', null);
    if (_.get(project, 'wizard.repository.settings.sharedUser')) {
        githubAccessToken = config.container.shared.githubAccessToken;
    }

    return githubAccessToken;
};

const getDefaultBranch = async (project, user) => {
    const githubAccessToken = getGithubAccessToken(project, user);
    const repoSource = project?.wizard?.theme?.settings?.source;

    if (!repoSource) {
        throw new errorUtils.ResponseError('ThemeSourceNotFound');
    }

    const { owner, repo } = decodeRepoUrl(repoSource);
    return githubRepo.fetchDefaultBranch({ owner, repo, token: githubAccessToken });
};

module.exports = {
    deploy: async function (project, user, buildLogger) {
        try {
            let repoData = {};
            let mainBranch = '';
            let githubAccessToken = getGithubAccessToken(project, user);

            if (project?.wizard?.theme?.settings?.multiSite) {
                const repoSource = project?.wizard?.theme?.settings?.source;

                if (!repoSource) {
                    throw new errorUtils.ResponseError('ThemeSourceNotFound');
                }

                const { owner, repo } = decodeRepoUrl(repoSource);
                // only users who has access to the repo can create multiSite projects
                repoData = await githubRepo.getRepoDetails({ owner, repo, token: githubAccessToken });
                const branches = await githubRepo.fetchBranches({ owner, repo, token: githubAccessToken });
                const previewBranch = project?.deploymentData?.[project.wizard.cms.id]?.branch;
                mainBranch = repoData.default_branch;

                const existingBranch = _.find(branches, { name: previewBranch });
                if (!existingBranch) {
                    await githubRepo.createBranch({
                        owner,
                        repo,
                        token: githubAccessToken,
                        fromBranch: mainBranch,
                        newBranch: previewBranch
                    });
                    await githubRepo.protectBranch(owner, repo, githubAccessToken, previewBranch);
                }
                mainBranch = project?.wizard?.theme?.settings?.branch;
            } else {
                let gitPushRepo = gitService.initAndPushRepo;
                if (_.get(project, 'wizard.repository.settings.pushExisting')) {
                    gitPushRepo = gitService.pushExistingRepo;
                }

                buildLogger.debug('Github: Creating repository');
                repoData = await withRetry(() => githubRepo.createRepo(project, githubAccessToken, buildLogger), { logger: buildLogger });
                buildLogger.debug('Github: Uploading project to repo');
                const outputDir = project?.deploymentData?.build?.outputDir;
                // here we have created a repo, and default branch might be whatever (e.g. main) but repo has not been pushed,
                // and default branch of the repo is e.g. master.
                const cmsId = project?.wizard?.cms?.id;
                const branch = project?.deploymentData?.[cmsId]?.branch;
                const options = { branches: _.compact([branch]) };
                const pushRepoData = await gitPushRepo(outputDir, repoData, githubAccessToken, options, buildLogger);
                mainBranch = pushRepoData.mainBranch;
            }

            let updatedProject = await Project.updateDeploymentData(project._id, 'github', {
                id: repoData.id,
                url: repoData.html_url,
                repoName: repoData.name,
                fullName: repoData.full_name,
                private: repoData.private,
                sshURL: repoData.ssh_url,
                ownerLogin: repoData.owner.login,
                defaultBranch: mainBranch
            });

            const { webhookId } = await withRetry(() => githubRepo.createStackbitWebhook(updatedProject, githubAccessToken), { logger: buildLogger });
            updatedProject = await Project.updateProject(updatedProject._id, { 'webhooks.github.repoName': webhookId }, user._id);

            const cmsId = updatedProject?.wizard?.cms?.id;
            const branch = updatedProject?.deploymentData?.[cmsId]?.branch;
            const owner = updatedProject?.deploymentData?.github?.ownerLogin;
            const repo = updatedProject?.deploymentData?.github?.repoName;
            const privateRepo = updatedProject?.wizard?.repository?.settings?.privateRepo;
            // API based cms dont have a preview branch
            // Branch protection for private repos is only available on the Github Pro plan
            if (branch && !privateRepo) {
                return githubRepo.protectBranch(owner, repo, githubAccessToken, branch).then(() => updatedProject);
            }
            return updatedProject;
        } catch(err) {
            if (ResponseErrors[err.name]) {
                throw err;
            }

            buildLogger.error('Github: failed to create repo', err);
            throw ResponseErrors.ErrorWithDebug('GithubFailedToCreateRepo', err);
        }
    },
    createDeployKey: function (project, user, publicKey, deployKeyName, allowWrite) {
        const githubAccessToken = getGithubAccessToken(project, user);

        return githubRepo.createDeployKey(project, publicKey, githubAccessToken, deployKeyName, allowWrite);
    },
    onWebhook: function (project, user, req) {
        const id = project.id;
        const event = req.body;
        const action = _.get(req, 'headers.x-github-event');
        logger.debug('Webhook: Github', action);

        if (action === 'push') {
            // Track commit data
            const headCommit = _.get(event, 'head_commit');
            const commitAuthor = _.get(event, 'head_commit.author');
            const commitCommitter = _.get(event, 'head_commit.committer');
            const commitSourceType = determineCommitSource(headCommit);

            if (_.get(commitAuthor, 'username') === 'dependabot[bot]') {
                logger.debug('Webhook: Github - Ignoring dependabot');
                return Promise.resolve();
            }

            if (commitSourceType === 'developer') {
                Project.updateDeveloperMetrics(id, headCommit);
            }

            analytics.track('Webhook: Github Push', {
                projectId: id,
                userId: user.id,
                ssg: _.get(project, 'wizard.ssg.id'),
                theme: _.get(project, 'wizard.theme.id'),
                commitFilesAdded: _.take(_.get(headCommit, 'added'), 10),
                commitFilesModified: _.take(_.get(headCommit, 'modified'), 10),
                commitFilesRemoved: _.take(_.get(headCommit, 'removed'), 10),
                commitAuthor,
                commitCommitter,
                commitSourceType
            }, user);
        }

        if (['push', 'delete'].includes(action)) {
            let branch = null;
            if (_.get(event, 'ref_type') === 'branch') {
                branch = _.get(event, 'ref');
            }
            if (!branch) {
                const branchMatch = _.get(event, 'ref', '').match(/refs\/heads\/(.*)/);
                if (branchMatch) {
                    branch = branchMatch[1];
                }
            }
            // require here to prevent circular dependency during server startup.
            logger.debug('Webhook: Github triggerAutoBuild', { projectId: id, userId: user.id, branch, action });
            require('../deployments').callDeploymentMethodForProject('triggerAutoBuild', project, user, {branch, action});
        }

        const isPRClosed = action === 'closed' && _.get(project, 'deploymentData.build.pullRequest.id') === _.get(event, 'pull_request.id');
        const repoData = _.get(event, 'repository');
        const githubDeployment = {};

        if (repoData) {
            githubDeployment.url = repoData.html_url;
            githubDeployment.repoName = repoData.name;
            githubDeployment.fullName = repoData.full_name;
            githubDeployment.private = repoData.private;
            githubDeployment.sshURL = repoData.ssh_url;
            githubDeployment.ownerLogin = repoData.owner.login;

            /*
             * Fixes issue with race condition for deploying project with publishBranch and receiving webhook with `main` default branch
             * https://www.notion.so/stackbit/API-Publish-branch-update-race-condition-6098ec7802a948e6a7072c152de0f48a
             */

            // deployedAt is actual mark that project has been deployed, if value is not set - project isn't deployed
            if (project.deployedAt) {
                // anyways, defaultBranch value change doesn't affect deploymentData.container.publishBranch
                // in cases user changes main branch of the repo manually
                githubDeployment.defaultBranch = repoData.default_branch;
            }
        }

        const isRepoTransferred = event.action === 'transferred';
        if (isRepoTransferred && repoData) {
            githubDeployment.transferStatus = 'transferred';
            analytics.track('Transfer Repo Success', {
                projectId: project.id,
                userId: user.id
            }, user);
        }

        if (isPRClosed) {
            analytics.track('Theme Update Pull Request Closed', {
                merged: _.get(event, 'pull_request.merged'),
                projectId: project.id,
                userId: user.id
            }, user);
        }

        return Promise.all([
            Project.updateDeploymentData(id, 'github', githubDeployment),
            action === 'renamed' ? Project.updateMetrics(id, {didChangeGithubName: true}) : null,
            Project.updateProject(id, { 'webhooks.github.repoName': githubDeployment.fullName }, user._id),
            isPRClosed ? Project.updateDeploymentData(id, 'build', {
                updateSuccessful: _.get(event, 'pull_request.merged'),
                pullRequest: null
            }) : null
        ]);
    },

    transferRepo(project, user, buildLogger) {
        buildLogger.debug('Github: Transferring repository');

        // for shared container we use token of the special stackbit user
        // @todo use token of the "user" who will grant transfer
        const token = _.get(project, 'wizard.repository.settings.sharedUser') ? config.container.shared.githubAccessToken : null;
        if (token) {
            return withRetry(() => githubRepo.transferRepoToTheUser({ token, project, user }), { logger: buildLogger, retryDelay: 2000 })
                .then(() => {
                    buildLogger.debug('Github: Transfer repo requested successfully');
                    analytics.track('Transfer Repo Initiated', {
                        projectId: project.id,
                        userId: user.id
                    }, user);
                    return Project.updateDeploymentData(project.id, 'github', { transferStatus: 'initiated', transferRequestDate: new Date() });
                })
                .catch(err => {
                    return Project.updateDeploymentData(project.id, 'github', { transferStatus: 'failed' })
                        .then(() => {
                            analytics.track('Transfer Repo Initiation Error', {
                                projectId: project.id,
                                userId: user.id
                            }, user);
                            buildLogger.error('Github: Error: Cannot transfer repo',  err);
                            throw err;
                        });
                });
        }

        buildLogger.debug('Github: Skipping transferring repository.');

        return Promise.resolve(project);
    },

    importExisting(project, user, branch, publishBranch, buildLogger) {
        let { githubAccessToken } = user;
        if (_.get(project, 'deploymentData.github.repoName')) {
            return Promise.resolve(project);
        }
        const owner = _.get(project, 'wizard.repository.settings.ownerLogin');
        const repo = _.get(project, 'wizard.repository.settings.repoName');
        const token = _.get(project, 'wizard.repository.settings.sharedUser') ? config.container.shared.githubAccessToken : githubAccessToken;
        return githubRepo.getRepoDetails({ owner, repo, token })
            .then(repoDetails => {
                const { default_branch: defaultBranch } = repoDetails;

                return Project.updateDeploymentData(project.id, 'github', {
                    ownerLogin: owner,
                    repoName: repo,
                    sshURL: project?.wizard?.repository?.settings?.sshURL ?? '',
                    url: repoDetails.html_url,
                    defaultBranch
                }).then(project => {
                    return githubRepo.createStackbitWebhook(project, githubAccessToken);
                }).catch(err => {
                    if (err === ResponseErrors.GithubWebhookExists) {
                        logger.error('Github ImportExisting: Github Webhook Already Exists');
                        return; // continue execution
                    }
                    throw err;
                }).then(() => {
                    return githubRepo.fetchBranches({ owner, repo, token }).then(branches => {
                        const existingBranch = _.find(branches, { name: branch });
                        if (!existingBranch) {
                            return githubRepo.createBranch({ owner, repo, token, fromBranch: publishBranch, newBranch: branch})
                                .then(() => githubRepo.protectBranch(owner, repo, token, branch));
                        }
                    });
                }).then(() => Project.findProjectById(project.id)
                ).catch(err => {
                    return Project.updateDeploymentData(project.id, 'github', { repoName: null }).then(() => {
                        throw err;
                    });
                });
            });
    },

    putFile(project, user, fileContents, contentPath, commitMessage, branch, commitSha) {
        const githubAccessToken = getGithubAccessToken(project, user);
        const githubConnection = user.connections.find(connection => connection.type === 'github-app');
        // user might not have displayName, so fallback on connectionUserEmail
        const displayName = user.displayName || user.email;
        return githubRepo.createOrUpdateFileContents({
            repo: project.getDeploymentData('github.repoName'),
            token: githubAccessToken,
            owner: project.getDeploymentData('github.ownerLogin'),
            path: contentPath,
            content: fileContents,
            message: commitMessage,
            commitSha,
            committer: {
                name: config.container.shared.projectsGithubUsername,
                email: config.container.shared.projectsGithubEmail
            },
            author: {
                name: displayName,
                email: githubConnection?.connectionUserEmail
            },
            branch
        });
    },

    async contentExists(project, user, contentPath, ref, buildLogger) {
        const githubAccessToken = getGithubAccessToken(project, user);
        try {
            const data = await githubRepo.fetchFileFromRepo(
                {
                    repo: project.getDeploymentData('github.repoName'),
                    token: githubAccessToken,
                    owner: project.getDeploymentData('github.ownerLogin')
                },
                contentPath,
                ref
            );
            return { exists: true, sha: data.sha };
        } catch (err) {
            if (err.status === 404) {
                return { exists: false };
            }

            buildLogger.debug('Github: Error fetching file content');
            throw err;
        }
    },

    addBuildStatusWebhooks(project, user) {
        const githubAccessToken = getGithubAccessToken(project, user);
        return githubRepo.createGithubActionWebhook(project, githubAccessToken, 'build/github-action', ['check_run']);
    },

    async setDeploymentBuildProgress(project, eventName, data) {
        const repoTransferred = _.get(project, 'deploymentData.github.transferStatus') === 'transferred';
        const isSharedUser =  _.get(project, 'wizard.repository.settings.sharedUser');
        const linkAvailable = !isSharedUser || repoTransferred;
        // https://developer.github.com/v3/checks/runs/#parameters
        const deployId = _.get(data, 'check_run.id');
        // there's no way to compose url to live logs data
        // https://github.community/t/logs-and-artifacts-not-available-in-api-for-in-progress-runs/132091
        const externalBuildLogLink = linkAvailable ? _.get(data, 'check_run.html_url') : '';
        const action = data.action;
        const status = _.get(data, 'check_run.status');
        const conclusion = _.get(data, 'check_run.conclusion');
        const deploymentId = _.get(project, 'wizard.deployment.id', null);

        // @todo add state machine like for Netlify build progress
        if (conclusion === 'skipped') {
            return Promise.resolve(project);
        }

        await Project.updateDeploymentData(project.id, 'github', {
            runId: deployId,
        }, null);

        // if project has no deployment then don't update build status
        if (!deploymentId) {
            return Promise.resolve(project);
        }

        switch (action) {
        case 'created':
            return Project.updateDeploymentData(project.id, deploymentId, {
                connected: true,
                deploy_id: deployId,
                build_status: status,
                buildProgress: 'building',
                externalBuildLogLink,
            }, null).then(project => {
                return Project.updateBuildStatus(project._id, 'deploying', {message: null, countDeploy: true});
            });
        case 'completed':
            return Project.updateDeploymentData(project.id, deploymentId, {
                connected: true,
                deploy_id: deployId,
                build_status: status,
                buildProgress: conclusion === 'success' ? 'ready' : 'error',
                externalBuildLogLink,
                completed_at: _.get(data, 'check_run.details.url')
            }, null).then(project => {
                const buildStatus = conclusion === 'success' ? 'live' : 'failing';
                const update = buildStatus === 'live' ? { countDeploySuccess: true, project } : {};
                return Project.updateBuildStatus(project._id, buildStatus, update);
            });
        default:
            return Promise.resolve(project);
        }
    },
    getAccessToken: getGithubAccessToken,
    getDefaultBranch
};
