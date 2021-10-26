const _ = require('lodash');

/**
 * @typedef {'forestry' | 'contentful' | 'netlifycms' | 'datocms' | 'sanity' | 'devto'} CMSId
 */

/**
 * @typedef {{ wizard: { cms: { id: CMSId } } }} ProjectModel
 */

/**
 * @typedef {({ project: ProjectModel, user: Object, data: Object })} createPage
 * @typedef {({ project: ProjectModel, user: Object, data: Object })} duplicatePage
 * @typedef {({ project: ProjectModel, user: Object, data: Object })} updatePage
 * @typedef {({ project: ProjectModel, user: Object, objects: Object })} hasChanges
 * @typedef {({ project: ProjectModel, objects: Object, buildLogger: Object })} publishDrafts
 * @typedef {({ project: ProjectModel, user: Object })} hasAccess
 * @typedef {({ project: ProjectModel, user: Object, buildLogger: Object })} contextForBuild
 * @typedef {({ project: ProjectModel, user: Object, req: Object })} onWebhook
 * @typedef {({ project: ProjectModel, user: Object })} envForContainer
 * @typedef {({ project: ProjectModel, user: Object })} preProvision
 * @typedef {({ project: ProjectModel, user: Object, buildLogger: Object })} preDeploy
 * @typedef {({ project: ProjectModel, user: Object, draftsReadyCallback: Function, progressCallback: Function })} provision
 */

/**
 * @typedef {createPage | duplicatePage | updatePage | hasChanges | publishDrafts | hasAccess | contextForBuild | onWebhook | envForContainer | preProvision | provision} CMSInterface
 */

/**
 * @typedef {{string: CMSInterface }} CMSTypes
 */

/** @type {CMSTypes} */
const cmsTypes = {
    git: require('./gitcms'),
    forestry: require('./forestry'),
    netlifycms: require('./netlify-cms'),
    contentful: require('./contentful'),
    datocms: require('./datocms'),
    sanity: require('./sanity'),
    devto: require('./devto')
};

/**
 * @param {'createPage' | 'duplicatePage' | 'updatePage' | 'hasChanges' | 'hasAccess' | 'publishDrafts' | 'createObject' | 'envForContainer' | 'provision' | 'customImport' | 'customImportEnvVars' } op
 * @param {ProjectModel} project
 * @param {any?} args
 * @return {Promise<ProjectModel | Object>}
 */
function baseInvokeContentSourcesWithProject(op, project, ...args) {
    /** @type {CMSId} */
    const cmsId = _.get(project, 'wizard.cms.id');
    /** @type {CMSTypes} */
    const cmsType = _.get(cmsTypes, cmsId);
    const importCmsType = _.get(cmsTypes, _.get(project, 'importData.dataType'));
    /** @type {[CMSTypes]} */
    const contentSources = _.uniq([cmsType, importCmsType].filter(Boolean));
    if (_.isEmpty(contentSources)) {
        return Promise.resolve(project);
    }
    return contentSources.map(obj => ((project) => {
        /** @type {CMSInterface} */
        const func = _.get(obj, op);
        if (func) {
            return func.call(obj, project, ...args);
        }
        return Promise.resolve(project);
    })).reduce((prev, next) => {
        return prev.then((project) => next(project));
    }, Promise.resolve(project));
}

function baseOnWebhook(project, user, req) {
    const cmsType = _.get(cmsTypes, _.get(project, 'wizard.cms.id'));

    if (cmsType && cmsType.onWebhook) {
        return cmsType.onWebhook(project, user, req);
    }

    return Promise.resolve(project);
}

function baseContextForBuild(project, user, buildLogger) {
    const cmsType = _.get(cmsTypes, _.get(project, 'wizard.cms.id'));

    if (cmsType && cmsType.contextForBuild) {
        return cmsType.contextForBuild(project, user, buildLogger);
    }

    return [];
}

function baseCustomImportEnvVars(project) {
    const cmsType = _.get(cmsTypes, _.get(project, 'wizard.cms.id'));
    if (cmsType && cmsType.customImportEnvVars) {
        return cmsType.customImportEnvVars(project);
    }
    return {};
}

function baseEnvForDeployment(project) {
    const cmsType = _.get(cmsTypes, _.get(project, 'wizard.cms.id'));

    if (cmsType && cmsType.envForDeployment) {
        return cmsType.envForDeployment(project);
    }

    return {};
}

module.exports = {
    baseInvokeContentSourcesWithProject,
    baseOnWebhook,
    baseContextForBuild,
    baseEnvForDeployment,
    baseCustomImportEnvVars
};
