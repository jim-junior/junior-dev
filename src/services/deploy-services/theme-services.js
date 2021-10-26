const _ = require('lodash');
const gitService = require('./git-service');
const ResponseErrors = require('../../routers/response-errors');
const config = require('../../config').default;

function sourceInputTheme(project, user, buildLogger, {dirname = 'source'} = {}) {
    const {PATH_TO_GENERATED} = require('./factory-service');
    const {source, branch, commit} = getThemeSettingsForBuild(project, buildLogger);
    if (_.get(project, 'importData.importedPath')) {
        return Promise.resolve({
            repoPath: _.get(project, 'importData.importedPath')
        });
    } else {
        const cloneUrl = authorizedThemeUrl(source, user);
        const clonePath = PATH_TO_GENERATED + project.id + '/' + dirname;

        buildLogger.debug('Theme Service: fetching theme repo', {cloneUrl, branch, commit});

        return gitService.cloneRepo(clonePath, cloneUrl, buildLogger, {branch, commit}).catch(err => {
            buildLogger.error(err);
            throw ResponseErrors.GithubSourceRepoNotFound;
        });
    }
}

function getThemeSettingsForBuild(project, logger) {
    const {source, branch, commit} = _.get(project, 'wizard.theme.settings', {});
    if (hasHandcraftedNextjsTheme(project)) {
        const replaceSource = config.build.handcraftedNextjsThemes[source];
        logger.debug('Build: replacing unibit theme with nextjs theme', {source, replaceSource});
        return {source: replaceSource, branch: 'master'};
    }

    return {source, branch, commit}
}

function hasHandcraftedNextjsTheme(project) {
    const source = _.get(project, 'wizard.theme.settings.source');
    const ssg = _.get(project, 'wizard.ssg.id');
    const cms = _.get(project, 'wizard.cms.id');
    const deployment = _.get(project, 'wizard.deployment.id');
    return ssg === 'nextjs' && cms === 'git' && deployment === 'netlify' && _.has(config.build.handcraftedNextjsThemes, source);
}

function authorizedThemeUrl(cloneUrl, user) {
    if (isStackbitTheme(cloneUrl)) {
        const personalAccessToken = config.build.themesPAK;
        cloneUrl = cloneUrl.replace('https://github.com/', `https://${personalAccessToken}:x-oauth-basic@github.com/`);
    } else if (user && user.githubAccessToken) {
        // Non-Stackbit Theme
        cloneUrl = cloneUrl.replace('https://github.com/', `https://${user.githubAccessToken}:x-oauth-basic@github.com/`);
    }

    return cloneUrl;
}

function isStackbitTheme(url) {
    if (!url) {
        return false;
    }

    return !!url.match(/^https:\/\/github.com\/stackbit-themes\/(.*)-unibit/);
}

module.exports = {
    sourceInputTheme,
    getThemeSettingsForBuild,
    hasHandcraftedNextjsTheme,
    authorizedThemeUrl,
    isStackbitTheme
};
