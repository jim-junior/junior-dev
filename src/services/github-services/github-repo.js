const { Octokit } = require('@octokit/rest');
const _ = require('lodash');
const projectUtils = require('../project-services/project-utils').default;
const ResponseErrors = require('../../routers/response-errors');
const config = require('../../config').default;
const logger = require('../../services/logger');

function fetchFileFromRepo({owner, repo, token, rawData = false}, file, ref) {
    return new Octokit({auth: token ? 'token ' + token : null}).repos.getContent({
        owner: owner,
        repo: repo,
        path: file,
        ...(ref ? {ref} : {})
    }).then(result => {
        return result.data;
    }).catch(err => {
        if ([404, 403, 401].includes(err.status) && token) {
            return fetchFileFromRepo({owner, repo, token: null}, file, ref);
        }

        throw err;
    });
}

function createPullRequest({owner, repo, token, options: {title, head, base}}) {
    return new Octokit({auth: 'token ' + token}).pulls.create({
        owner,
        repo,
        title,
        head,
        base
    }).then(resp => resp.data);
}

function fetchBranches({owner, repo, token}) {
    return new Octokit({auth: token ? 'token ' + token : null}).paginate('GET /repos/{owner}/{repo}/branches', {
        owner,
        repo
    }).catch(err => {
        if ([404, 403, 401].includes(err.status) && token) {
            return fetchBranches({owner, repo, token: null});
        }
        throw err;
    });
}

function fetchDefaultBranch({owner, repo, token}) {
    return new Octokit({auth: token ? 'token ' + token : null}).repos.get({
        owner,
        repo
    }).then(resp => resp.data.default_branch).catch(err => {
        if ([404, 403, 401].includes(err.status) && token) {
            return fetchDefaultBranch({owner, repo, token: null});
        }

        throw err;
    });
}

function createBranch({owner, repo, token, fromBranch, newBranch}) {
    return new Octokit({auth: 'token ' + token}).repos.getBranch({
        owner,
        repo,
        branch: fromBranch || 'master'
    }).then(result => {
        return new Octokit({auth: 'token ' + token}).git.createRef({
            owner,
            repo,
            ref: `refs/heads/${newBranch}`,
            sha: _.get(result, 'data.commit.sha'),
        });
    }).then(result => result.data);
}

function fetchMasterTree({owner, repo, token}) {
    return new Octokit({auth: 'token ' + token}).repos.getBranch({
        owner,
        repo,
        branch: 'master'
    }).then(result => {
        return new Octokit({auth: 'token ' + token}).git.getTree({
            owner,
            repo,
            tree_sha: _.get(result, 'data.commit.sha'),
            recursive: 1
        });
    }).then(result => result.data);
}

function getGithubUser(token) {
    return new Octokit({auth: 'token ' + token}).users.getAuthenticated().then(result => {
        return result.data;
    });
}

async function createUserAccountRepo(repoName, privateRepo, token, metadata = {}) {
    const octokit = new Octokit({auth: 'token ' + token});
    const createRepoResponse = await octokit.repos.createForAuthenticatedUser({
        name: repoName,
        private: privateRepo,
        auto_init: false,
        description: metadata.description,
        homepage: metadata.homepage
    });

    if (metadata.topics) {
        try {
            const owner = _.get(createRepoResponse, 'data.owner.login');

            await octokit.repos.replaceAllTopics({
                owner,
                repo: repoName,
                names: metadata.topics
            });
        } catch (error) {
            logger.error('Github: Error setting repo topics', {error});
        }
    }

    return createRepoResponse;
}

async function createOrgAccountRepo(org, repoName, privateRepo, token, metadata = {}) {
    const octokit = new Octokit({auth: 'token ' + token});
    const createRepoResponse = await octokit.repos.createInOrg({
        name: repoName,
        private: privateRepo,
        org: org,
        auto_init: false,
        description: metadata.description,
        homepage: metadata.homepage
    });

    if (metadata.topics) {
        try {
            await octokit.repos.replaceAllTopics({
                owner: org,
                repo: repoName,
                names: metadata.topics
            });
        } catch (error) {
            logger.error('Github: Error setting repo topics', {error});
        }
    }

    return createRepoResponse;
}

function createRepo(project, token, buildLogger, retry = 0, retryName = null) {
    const metadata = {
        description: 'Jamstack site created with Stackbit',
        homepage: 'https://jamstack.new',
        topics: [
            'jamstack',
            'stackbit',
            'ssg',
            'headless',
            'static',
            _.get(project, 'wizard.ssg.id'),
            _.get(project, 'wizard.cms.id')
        ]
    };
    let repoName = _.get(project, 'wizard.repository.settings.sharedUser')
        ? projectUtils.uniqueAlphanumericName(project, retryName || project.name)
        : projectUtils.alphanumericName(retryName || project.name);
    let repoPromise;
    if (_.get(project, 'wizard.repository.settings.orgLogin')) {
        repoPromise = createOrgAccountRepo(_.get(project, 'wizard.repository.settings.orgLogin'), repoName, _.get(project, 'wizard.repository.settings.privateRepo', config.github.privateRepos), token, metadata);
        buildLogger.debug('Github: creating organization account repo', {orgLogin: _.get(project, 'wizard.repository.settings.orgLogin')});
    } else {
        repoPromise = createUserAccountRepo(repoName, _.get(project, 'wizard.repository.settings.privateRepo', config.github.privateRepos), token, metadata);
        buildLogger.debug('Github: creating user account repo');
    }
    return repoPromise.then(result => {
        return result.data;
    }).catch(err => {
        if (_.get(err, 'errors[0].message') === 'name already exists on this account') {
            if (retry < 3) {
                const copyName = projectUtils.duplicateProjectName(retryName || project.name);
                buildLogger.debug('Github: Warning: Repo name taken, retrying with copy-name', {copyName: copyName});
                return createRepo(project, token, buildLogger, retry + 1, copyName);
            } else if (retry < 4) {
                const copyName = projectUtils.duplicateProjectName(retryName || project.name, true);
                buildLogger.debug('Github: Warning: Repo name taken, retrying with random-name', {copyName: copyName});
                return createRepo(project, token, buildLogger, retry + 1, copyName);
            } else {
                buildLogger.error('Github: Error: Repo name taken, Retried 4 times, failing', {projectName: project.name});
                throw ResponseErrors.GithubRepoNameExists;
            }
        } else if (err.status === 403) {
            throw ResponseErrors.GithubRepoCreationPermissionDenied;
        } else {
            if (_.get(err, 'errors[0]')) {
                let innerErr = _.get(err, 'errors[0]');
                buildLogger.error('Github: Error creating repo', {innerErr, error: err});
                throw innerErr;
            }
        }

        buildLogger.error('Github: Error: Cannot create repo', err);
        throw err;
    });
}

function deleteRepo(project, token) {
    const githubAccessToken = getRepoToken(project, token);
    const repoDetails = _.get(project, 'deploymentData.github');
    return new Octokit({auth: 'token ' + githubAccessToken}).repos.delete({
        repo: repoDetails.repoName,
        owner: repoDetails.ownerLogin
    }).catch((err) => {
        if (err && err.code === 404) {
            return true; // if repo was already deleted
        }
        throw err;
    });
}

function createDeployKey(project, publicKey, token, deployKeyName, allowWrite=false) {
    const repoDetails = _.get(project, 'deploymentData.github');
    return new Octokit({auth: 'token ' + token}).repos.createDeployKey({
        owner: repoDetails.ownerLogin,
        repo: repoDetails.repoName,
        title: deployKeyName || 'Stackbit Deploy Key',
        key: publicKey,
        read_only: !allowWrite
    }).then(result => {
        return result.data;
    });
}

async function createStackbitWebhook(project, token, eventName =  'github', events = ['push', 'delete', 'pull_request', 'repository']) {
    const repoDetails = project?.deploymentData?.github;
    const { ownerLogin, repoName } = repoDetails;
    const stackbitWebhookExists = await hasStackbitWebhookURL(ownerLogin, repoName, token);

    if (!stackbitWebhookExists) {
        const webhookHostname = config.server.webhookHostname;
        const webhookURL = new URL('/webhook/github/', webhookHostname).toString();

        await new Octokit({ auth: 'token ' + token }).repos.createWebhook({
            owner: ownerLogin,
            repo: repoName,
            name: 'web',
            config: {
                url: webhookURL,
                content_type: 'json'
            },
            events,
            active: true
        });
    }

    return {
        webhookId: `${ownerLogin}/${repoName}`
    };
}

const hasStackbitWebhookURL = async (ownerLogin, repoName, token) => {
    const webhookHostname = config.server.webhookHostname;
    const webhookURL = new URL('/webhook/github/', webhookHostname).toString();
    const repoWebhooks = await new Octokit({ auth: 'token ' + token }).repos.listWebhooks({
        owner: ownerLogin,
        repo: repoName,
    });

    return Boolean(repoWebhooks.data.find(repoWebhook => {
        return repoWebhook.config.url === webhookURL;
    }));
};

function createGithubActionWebhook(project, token, eventName, events) {
    const repoDetails = _.get(project, 'deploymentData.github');
    let webhookHostname = config.server.webhookHostname;
    const githubWebhookURL = `${webhookHostname}/project/${project.id}/webhook/${eventName}`;
    return new Octokit({auth: 'token ' + token}).repos.createWebhook({
        owner: repoDetails.ownerLogin,
        repo: repoDetails.repoName,
        name: 'web',
        config: {
            url: githubWebhookURL,
            content_type: 'json'
        },
        events,
        active: true
    }).then(result => {
        return result.data;
    }).catch(err => {
        const errors = _.get(err, 'errors', []);
        const alreadyExists = _.find(errors, errObj => errObj.message.toLowerCase().startsWith('hook already exists'));
        if (alreadyExists) {
            throw ResponseErrors.GithubWebhookExists;
        }
        throw err;
    });
}

// function commitStatus(project, {commit, state, targetUrl, description, context}, token) {
//     const repoDetails = _.get(project, 'deploymentData.github');
//     return new Octokit({auth: 'token ' + token}).repos.createStatus({
//         owner: repoDetails.ownerLogin,
//         repo: repoDetails.repoName,
//         sha: commit,
//         state: state,
//         target_url: targetUrl,
//         description: description,
//         context: context
//     });
// }

function transferRepoToTheUser({ token, project, user }) {
    const repoDetails = _.get(project, 'deploymentData.github');
    const repoUrl = repoDetails.url;
    const connections = _.get(user, 'connections');
    const newOwnerGithubConnection = _.find(connections, { type: 'github-app' });
    const newOwnerAccessToken = _.get(newOwnerGithubConnection, 'accessToken');

    if (repoUrl.includes(`/${config.github.orgName}/`)) {
        throw new Error(`Forbidden to transfer repo ${repoUrl}`);
    }

    if (!newOwnerGithubConnection) {
        throw new Error('User doesn\'t have GitHub connection.');
    }

    return getGithubUser(newOwnerAccessToken).then((data = {}) => {
        return data.login;
    }).then(newOwner => {
        return new Octokit({ auth: 'token ' + token }).repos.transfer({
            owner: repoDetails.ownerLogin,
            new_owner: newOwner,
            repo: repoDetails.repoName
        });
    });
}

function compareBranches({ token, project, base, head }) {
    const githubAccessToken = getRepoToken(project, token);
    const repoDetails = _.get(project, 'deploymentData.github');
    logger.debug('[compareBranches]', { repoDetails, base, head });
    return new Octokit({auth: 'token ' + githubAccessToken}).repos.compareCommits({
        repo: repoDetails.repoName,
        owner: repoDetails.ownerLogin,
        base,
        head
    }).then(response => ({
        behind: _.get(response, 'data.behind_by'),
        ahead: _.get(response, 'data.ahead_by')
    }));
}

function getRepoToken(project, token) {
    const isSharedProject = _.get(project, 'deploymentData.github.ownerLogin') === config.container.shared.projectsGithubUser;
    return isSharedProject ? config.container.shared.githubAccessToken : token;
}

function getRepoDetails({ owner, repo, token }) {
    return new Octokit({ auth: token ? 'token ' + token : null }).repos.get({ owner, repo })
        .then(result => result.data).catch(err => {
            if (err.status === 403) {
                const rateLimitRemaining = _.get(err, 'headers.x-ratelimit-remaining');
                if (rateLimitRemaining <= 0) {
                    throw ResponseErrors.GithubRateLimitReached;
                }
            }
            if (err.status === 404) {
                throw ResponseErrors.GithubRepoNotFound;
            }
            throw err;
        });
}

function protectBranch(owner, repo, token, branch) {
    return new Octokit({auth: 'token ' + token}).repos.updateBranchProtection({
        owner,
        repo,
        branch,
        required_status_checks: null,
        enforce_admins: null,
        required_pull_request_reviews: null,
        restrictions: null,
        allow_force_pushes: true
    }).then(result => {
        logger.debug('Github: branch protection success', {owner, repo, branch});
        return result.data;
    }).catch(err => {
        logger.warn('Github: branch protection failed', {owner, repo, branch, err});
    });
}

async function createOrUpdateFileContents({ token, owner, repo, branch, path, message, content, committer, commitSha, author }) {
    const logData = {
        owner,
        repo,
        branch,
        path,
        committer,
        sha: commitSha,
        author
    };
    try {
        const octokit = new Octokit({ auth: 'token ' + token });
        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path,
            message,
            branch,
            sha: commitSha,
            content: Buffer.from(content).toString('base64'),
            committer,
            author
        });
        logger.debug('Github: create or update file success', logData);
    } catch (err) {
        logger.warn('Github:  create or update file success failed', {
            ...logData,
            err
        });
        throw err;
    }
}

module.exports = {
    fetchFileFromRepo,
    fetchMasterTree,
    createPullRequest,
    fetchBranches,
    fetchDefaultBranch,
    getGithubUser,
    getRepoDetails,
    createRepo,
    createDeployKey,
    createStackbitWebhook,
    // commitStatus,
    deleteRepo,
    transferRepoToTheUser,
    createBranch,
    compareBranches,
    protectBranch,
    createOrUpdateFileContents,
    createGithubActionWebhook,
    hasStackbitWebhookURL
};
