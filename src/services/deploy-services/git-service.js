const gitP = require('simple-git/promise');
const rimraf = require('rimraf');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const os = require('os');
const uuid = require('uuid');
const childProcess = require('child_process');
const _ = require('lodash');

const logger = require('../logger');
const { getProcessPromise } = require('../utils/process.utils');
const  { withRetry } = require('../utils/code.utils');
const ResponseErrors = require('../../routers/response-errors');
const stackbitCommiterEmail = 'projects@stackbit.com';

module.exports = {
    initAndPushRepo: (outputDir, repo, token, options, buildLogger) => {
        let url = repo.clone_url.replace('https://github.com/', `https://${token}:x-oauth-basic@github.com/`);
        let mainBranch = 'master';
        const simpleRepo = gitP(outputDir).silent(true);
        return simpleRepo.init().then(() => {
            buildLogger.debug('gitP: Initted repo', {localRepo: outputDir, url});
            return simpleRepo.addConfig('user.name', 'Stackbit');
        }).then(() => {
            return simpleRepo.addConfig('user.email', stackbitCommiterEmail);
        }).then(() => {
            buildLogger.debug('gitP: Committing', {localRepo: outputDir});
            return simpleRepo.add('./*');
        }).then(() => {
            return simpleRepo.commit('initial commit by Stackbit', {'--author': `"Stackbit <${stackbitCommiterEmail}>"`});
        }).then(async () => {
            // create branches from "master" (e.g.: "preview" branch)
            const branches = _.get(options, 'branches', []);
            mainBranch = await getDefaultBranch(outputDir);
            return Promise.all(_.map(branches, branch => branch !== mainBranch && simpleRepo.checkoutBranch(branch, mainBranch)));
        }).then(() => {
            return simpleRepo.addRemote('origin', url);
        }).then(() => {
            // push all branches
            return withRetry(() => simpleRepo.push(['origin', '--all']), { logger: buildLogger, retryDelay: 2000 });
        }).then(() => {
            return simpleRepo.revparse(['HEAD']).then((hash) => {
                buildLogger.debug('gitP: Repo Pushed', {remoteRepo: url, hash: hash});
                return { mainBranch, hash };
            });
        });
    },
    pushExistingRepo: async (outputDir, repo, token, options, buildLogger) => {
        let url = repo.clone_url.replace('https://github.com/', `https://${token}:x-oauth-basic@github.com/`);
        // verify we're not taking the parent dir's repo
        if (!fs.existsSync(path.join(outputDir, '.git'))) {
            throw ResponseErrors.ErrorWithDebug('FailedToPushRepo');
        }
        // verify repo doesn't look like stackbit-api
        if (fs.existsSync(path.join(outputDir, 'src/server.js'))) {
            throw ResponseErrors.ErrorWithDebug('FailedToPushRepo');
        }
        const simpleRepo = gitP(outputDir).silent(true);
        // create branches from "master" (e.g.: "preview" branch)
        const branches = _.get(options, 'branches', []);
        const mainBranch = await getDefaultBranch(outputDir);
        return Promise.all(_.map(branches, branch => branch !== mainBranch && simpleRepo.checkoutBranch(branch, mainBranch))).then(() => {
            return simpleRepo.addRemote('neworigin', url);
        }).then(() => {
            // push all branches
            return withRetry(() => simpleRepo.push(['neworigin', '--all']), { logger: buildLogger });
        }).then(() => {
            return simpleRepo.revparse(['HEAD']).then((hash) => {
                buildLogger.debug('gitP: Repo Pushed', {remoteRepo: url, hash: hash});
                return { mainBranch, hash };
            });
        });
    },
    commitAndPushRepo: (outputDir, commitMessage, buildLogger) => {
        const simpleRepo = gitP(outputDir).silent(true);
        return commitChanges(outputDir, commitMessage, buildLogger).then(() => {
            buildLogger.debug('gitP: pushing to origin');
            return simpleRepo.push(['-u', 'origin', '--all']);
        }).then(() => {
            buildLogger.debug('gitP: Repo Pushed');
            return simpleRepo.revparse(['HEAD']);
        }).catch(err=>{
            throw ResponseErrors.ErrorWithDebug('FailedToPushProjectUpdateToRepo', {message: err.message});
        });
    },
    commitChanges: commitChanges,
    mergeFromTo: (outputDir, buildLogger, {fromBranch, toBranch}) => {
        const simpleRepo = gitP(outputDir).silent(true);
        return simpleRepo.addConfig('user.name', 'Stackbit').then(() => {
            return simpleRepo.addConfig('user.email', stackbitCommiterEmail);
        }).then(() => {
            buildLogger.debug('gitP: checking out merge target', {fromBranch, toBranch});
            return simpleRepo.checkout(toBranch);
        }).then(() => {
            buildLogger.debug('gitP: trying to merge', {fromBranch, toBranch});
            return simpleRepo.merge([fromBranch]);
        }).then(() => {
            buildLogger.debug('gitP: pushing to origin after merge');
            return simpleRepo.push(['-u', 'origin', '--all']);
        }).then(() => {
            buildLogger.debug('gitP: Repo Pushed');
            return simpleRepo.revparse(['HEAD']);
        }).catch(err=>{
            buildLogger.warn('gitP: failed to merge', {error:err, fromBranch, toBranch});
            throw err;
        });
    },
    cloneRepo: (clonePath, url, buildLogger, {branch, branchStart, commit, shouldDetachGit = true, cloneOptions = []}) => {
        return withRetry(() => gitP().silent(true).clone(url, clonePath, cloneOptions), { logger: buildLogger }).then(() => {
            if (branchStart) {
                return checkoutNewBranch(clonePath, buildLogger, {branchName: branch, startPoint: branchStart});
            } else {
                return checkoutRemote(clonePath, buildLogger, {commit, branch});
            }
        }).then(() => {
            return gitP(clonePath).silent(true).revparse(['HEAD']);
        }).then(hash => {
            if (shouldDetachGit) {
                return detachGit(clonePath).then(() => hash);
            }
            return hash;
        }).then(hash => {
            return {repoPath: clonePath, hash: hash};
        });
    },
    listRemote: (url, pattern, token) => {
        url = url.replace('https://github.com/', `https://${token}:x-oauth-basic@github.com/`);
        return gitP().silent(true).listRemote(['--heads', url, ...(pattern ? [pattern] : [])]).then(refs => {
            return refs.trim().split('\n').reduce((acc, cur) => {
                let pair = cur.split('\t');
                acc[pair[1]] = pair[0];
                return acc;
            }, {});
        });
    },
    createBranches: async (url, privateKey, publicKey, originBranch, branches) => {
        const {repo, repoDir} = await cloneWithPrivateKey(url, privateKey, publicKey);
        try {
            await repo.checkout(originBranch);
            for (const branch of branches) {
                await repo.checkoutBranch(branch, originBranch);
            }
            await repo.push('origin', '--all');
        } finally {
            await destroyCloneWithPrivateKey(repoDir);
        }
    },
    removeBranches: async (url, privateKey, publicKey, branches) => {
        const {repo, repoDir} = await cloneWithPrivateKey(url, privateKey, publicKey);
        try {
            for (const branch of branches) {
                await repo.push(['origin', '--delete', branch]);
            }
        } finally {
            await destroyCloneWithPrivateKey(repoDir);
        }
    },
    tagBranches: async (url, privateKey, publicKey, branches, tag) => {
        const {repo, repoDir} = await cloneWithPrivateKey(url, privateKey, publicKey);
        try {
            for (const branch of branches) {
                await repo.checkout(branch);
                await repo.tag([`${tag}-${branch}`]);
            }
            await repo.pushTags('origin');
        } finally {
            await destroyCloneWithPrivateKey(repoDir);
        }
    },
    updateBranchToAnother: async (url, privateKey, publicKey, fromBranch, toBranch) => {
        const {repo, repoDir} = await cloneWithPrivateKey(url, privateKey, publicKey);
        try {
            await repo.fetch();
            await repo.checkout(fromBranch);
            await repo.push(['-f', 'origin', `${fromBranch}:${toBranch}`]);
        } finally {
            await destroyCloneWithPrivateKey(repoDir);
        }
    },
    commitChangesToRepo: async (url, privateKey, publicKey, branch, performChanges) => {
        const {repo, repoDir} = await cloneWithPrivateKey(url, privateKey, publicKey);
        try {
            await repo.fetch();
            await repo.checkout(branch);
            const changes = await performChanges(repo, repoDir);
            if (changes && changes.message) {
                await repo.add('./*');
                await repo.commit(changes.message, {'--author': `"Stackbit <${stackbitCommiterEmail}>"`});
                await repo.push('origin', branch);
            }
        } finally {
            await destroyCloneWithPrivateKey(repoDir);
        }
    },
    removeWorkflows: (outputDir) => {
        const workflowsDir = path.join(outputDir, '.github', 'workflows');
        return fse.remove(workflowsDir);
    },
    syncBranchesWithRemote: async (outputDir, buildLogger, { branches = [] }) => {
        const repo = gitP(outputDir).silent(true);
        buildLogger.debug('gitP: Fetching remote');
        await repo.fetch();
        return Promise.all(branches.map(async branch => {
            buildLogger.debug(`gitP: Checkout ${branch}`);
            await repo.checkout(branch);
            buildLogger.debug(`gitP: Rebase origin ${branch}`);
            await repo.rebase([`origin/${branch}`]);
        }));
    }
};

function checkoutRemote(clonePath, buildLogger, {commit, branch}) {
    let repo = gitP(clonePath).silent(true);
    if (commit) {
        buildLogger.debug('gitP: Checking out commit', {commit});
        return repo.checkout(commit);
    } else if (branch) {
        buildLogger.debug('gitP: Checking out branch', {branch});
        return repo.checkout(['--track', 'refs/remotes/origin/' + branch]).catch(err=>{
            if (err.message.trim().match(/already exists.$/)) {
                buildLogger.debug(`gitP: tried to checkout remote branch ${branch} but it already exists locally. checking out local branch`, {error: err});
                return repo.checkout(branch);
            }

            buildLogger.debug(`gitP: Error checking out branch ${branch}`, {error: err, errorMessage: err.message});
            throw err;
        });
    }
}

async function checkoutNewBranch(clonePath, buildLogger, {branchName, startPoint}) {
    let repo = gitP(clonePath).silent(true);
    if (startPoint) {
        if (startPoint === true) {
            startPoint = await getInitialCommitHash(clonePath);
            buildLogger.debug('gitP: no startpoint defined, using initial commit', {branchName, startPoint});
        }
        buildLogger.debug('gitP: Creating branch from startpoint', {branchName, startPoint});
        return repo.checkoutBranch(branchName, startPoint);
    }
}

function detachGit(clonePath) {
    return new Promise((resolve, reject) => {
        return rimraf(path.join(clonePath, '.git'), (err) => {
            resolve();
        });
    });
}

async function getInitialCommitHash(outputDir) {
    return gitP(outputDir).silent(true).raw(['rev-list', '--max-parents=0', 'HEAD']).then(hash => {
        return hash.trim();
    });
}

async function getDefaultBranch(outputDir) {
    return gitP(outputDir).silent(true).raw(['symbolic-ref', '--short', 'HEAD']).then(branch => {
        return branch.trim();
    }).catch(err => {
        buildLogger.error('gitP: Cant get default repo branch, using master instead', err);
        return 'master';
    });
}

function cloneWithPrivateKey(url, privateKey, publicKey) {
    const dir = path.join(os.tmpdir(), uuid());
    const repoDir = path.join(dir, 'repo');
    const privateKeyFilename = path.join(dir, 'key');
    const publicKeyFilename = path.join(dir, 'key.pub');
    const sshCommand = `ssh -i ${privateKeyFilename} -o StrictHostKeyChecking=no`;
    return fse.mkdir(dir).then(() => {
        return Promise.all([
            fse.writeFile(privateKeyFilename, privateKey),
            fse.writeFile(publicKeyFilename, publicKey)
        ]);
    }).then(() => {
        return getProcessPromise(childProcess.spawn(
            'chmod',
            ['400', privateKeyFilename]
        ));
    }).then(() => {
        return getProcessPromise(childProcess.spawn(
            'ssh-add',
            [privateKeyFilename]
        ));
    }).then(() => {
        return getProcessPromise(childProcess.spawn(
            'git',
            ['clone', url, repoDir],
            {
                env: {
                    GIT_SSH_COMMAND: sshCommand
                }
            }
        ));
    }).then(() => {
        return {
            repo: gitP(repoDir).env('GIT_SSH_COMMAND', sshCommand),
            repoDir
        };
    });
}

function destroyCloneWithPrivateKey(clonePath) {
    const dir = path.join(clonePath, '../');
    const privateKeyFilename = path.join(dir, 'key');
    return getProcessPromise(childProcess.spawn(
        'ssh-add',
        ['-d', privateKeyFilename]
    )).then(() => {
        return new Promise((resolve, reject) => {
            return rimraf(dir, (err) => {
                resolve();
            });
        });
    });
}

function commitChanges(outputDir, commitMessage, buildLogger){
    const simpleRepo = gitP(outputDir).silent(true);
    return simpleRepo.addConfig('user.name', 'Stackbit').then(() => {
        return simpleRepo.addConfig('user.email', stackbitCommiterEmail);
    }).then(() => {
        return simpleRepo.add('./*');
    }).then(() => {
        buildLogger.debug('gitP: creating commit', {commitMessage});
        return simpleRepo.commit(commitMessage, {'--author': `"Stackbit <${stackbitCommiterEmail}>"`});
    }).catch(err=>{
        throw ResponseErrors.ErrorWithDebug('FailedToCommitToRepo', {message: err.message});
    });
}
