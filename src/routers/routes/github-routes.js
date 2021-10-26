const _ = require('lodash');
const {fetchBranches, fetchDefaultBranch, getRepoDetails} = require('../../services/github-services/github-repo');
const {decodeRepoUrl, getUserOrPublicGithubToken, isValidGithubUrl} = require('../../services/github-services/github-utils');
const ResponseErrors = require('../../routers/response-errors');

const getBranches = (req, res) => {
    const {repoUrl} = req.query;
    if (!isValidGithubUrl(repoUrl)) {
        return res.status(500).json(ResponseErrors.GithubUrlNotValid);
    }
    const { owner, repo } = decodeRepoUrl(repoUrl);
    const token = getUserOrPublicGithubToken(req.user);

    return fetchBranches({owner, repo, token}).then((branches) => {
        return fetchDefaultBranch({owner, repo, token}).then(defaultBranch => {
            return { branches, defaultBranch };
        });
    }).then(branchData => {
        res.json(branchData);
    }).catch(err => {
        res.status(err.status || 500).json(err);
    });
};

const getRepo = (req, res) => {
    const {repoUrl} = req.query;
    if (!isValidGithubUrl(repoUrl)) {
        return res.status(500).json(ResponseErrors.GithubUrlNotValid);
    }
    const { owner, repo } = decodeRepoUrl(repoUrl);
    const token = getUserOrPublicGithubToken(req.user);

    return getRepoDetails({owner, repo, token}).then(repoData => {
        res.json(repoData);
    }).catch(err => {
        res.status(err.status || 500).json(err);
    });
};

module.exports = {
    getBranches,
    getRepo
};
