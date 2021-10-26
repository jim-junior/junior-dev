const axios = require('axios');
const { SignJWT } = require('jose/jwt/sign');
import crypto from 'crypto';

const baseURL = 'https://api.netlify.com/api/v1';
const logger = require('../logger');
const config = require('../../config').default;
const _ = require('lodash');
const ResponseErrors = require('../../routers/response-errors');
const projectUtils = require('../project-services/project-utils').default;
const Project = require('../../models/project.model').default;

const SNIPPET_TITTLE = 'stackbit-widget';

// A temporary workaround for cyclic dependencies between deployment and other services
function getCMSService() {
    return require('../deploy-services/cmss');
}

function netlifyAPI(endpoint, method, data, token, {suppressErrorLogging = false} = {}) {
    const dataParam = ['get', 'delete'].includes(method) ? 'params' : 'data';
    return axios({
        method: method,
        url: baseURL + endpoint,
        [dataParam]: data,
        headers: {
            'Authorization': 'Bearer ' + token
        }
    }).then(response => {
        return response.data;
    }).catch((err) => {
        let error = err;
        if (err && err.response) {
            error = {
                code: err.response.status,
                data: err.response.data
            };
        } else {
            error = {
                code: err.code,
                message: err.message
            };
        }

        if (!suppressErrorLogging) {
            logger.error('Netlify: Error:', {endpoint: endpoint, params: data, response: error});
        }
        if (error.code === 401) {
            throw ResponseErrors.NetlifyTokenExpired;
        }
        if (error.code === 422 && _.get(error, 'data.errors.subdomain[0]') === 'must be unique') {
            throw ResponseErrors.NetlifyDomainTaken;
        }
        if (error.code === 429) {
            throw ResponseErrors.NetlifyAPIRateLimit;
        }
        throw error;
    });
}

function validateAccessToken(token) {
    if (!token) {
        return Promise.resolve(false);
    }

    return netlifyAPI('/user', 'get', null, token, {suppressErrorLogging: true}).then(()=>true).catch(()=>false);
}

function getUser(token) {
    return netlifyAPI('/user', 'get', null, token);
}

async function claimAnonNetlifySites(userId, token) {
    const claimToken = await getAnonClaimToken(userId);
    return netlifyAPI('/sites/claim', 'post', {token: claimToken}, token);
}

function getAnonClaimToken(userId) {
    const secretKey = crypto.createSecretKey(Buffer.from(config.netlify.anonClientSecret));
    return new SignJWT(
        {
            client_id: config.netlify.anonClientId,
            session_id: userId
        }
    )
        .setProtectedHeader({ alg: 'HS256' })
        .sign(secretKey);
}

async function getSharedClaimToken(projectId, userId) {
    const secretKey = crypto.createSecretKey(Buffer.from(config.netlify.shared.clientSecret));
    return await new SignJWT(
        {
            client_id: config.netlify.shared.clientId,
            session_id: `${userId}/${projectId}`
        }
    )
        .setProtectedHeader({ alg: 'HS256' })
        .sign(secretKey);
}

function createPublicKey(token) {
    return netlifyAPI('/deploy_keys', 'post', null, token);
}

function getWebhooks(siteId, netlifyToken) {
    return netlifyAPI('/hooks', 'get', {'site_id': siteId}, netlifyToken, {suppressErrorLogging: true});
}

function hasRestrictedWebhooks(project, siteId, netlifyAccessToken) {
    const hasRestrictedWebhooks = _.get(project, 'deploymentData.netlify.hasRestrictedWebhooks');
    if (_.isBoolean(hasRestrictedWebhooks)) {
        return Promise.resolve(hasRestrictedWebhooks);
    }
    return getWebhooks(siteId, netlifyAccessToken).then(webhooks => {
        const hasRestrictedWebhooks = _.some(webhooks, {'restricted': true});
        return Project.updateDeploymentData(project.id, 'netlify', {hasRestrictedWebhooks: hasRestrictedWebhooks}).then(() => {
            return hasRestrictedWebhooks;
        });
    });
}

function getBuildHooks(netlifySiteId, netlifyToken) {
    return netlifyAPI(`/sites/${netlifySiteId}/build_hooks`, 'get', null, netlifyToken);
}

function createBuildHookForStackbit(netlifySiteId, netlifyToken, branch, buildLogger) {
    buildLogger.debug('Netlify: creating build hook for Stackbit');
    return getBuildHooks(netlifySiteId, netlifyToken).then(hooks=>{
        let hook = _.find(hooks, {title: 'stackbit-build-hook', branch: branch});
        if (hook) {
            return hook;
        }

        return netlifyAPI(`/sites/${netlifySiteId}/build_hooks`, 'post', {
            branch: branch,
            title: 'stackbit-build-hook'
        }, netlifyToken);
    });
}

function deleteBuildHooksWithUrls(netlifySiteId, netlifyToken, buildHookUrls) {
    return getBuildHooks(netlifySiteId, netlifyToken).then(hooks => {
        const matchingHooks = hooks.filter(hook => buildHookUrls.includes(hook.url));
        return Promise.all(
            matchingHooks.map(hook => {
                return netlifyAPI(`/sites/${netlifySiteId}/build_hooks/${hook.id}`, 'delete', {}, netlifyToken);
            })
        );
    });
}

function deleteBuildHooksForStackbit(netlifySiteId, netlifyToken) {
    return getBuildHooks(netlifySiteId, netlifyToken).then(hooks => {
        let hook = _.find(hooks, {title: 'stackbit-build-hook', branch: 'master'});
        if (hook) {
            return netlifyAPI(`/sites/${netlifySiteId}/build_hooks/${hook.id}`, 'delete', {}, netlifyToken);
        }
    });
}

function createWebhooksForStackbit(project, eventName, siteId, netlifyToken) {
    let webhookHostname = config.server.webhookHostname;
    return netlifyAPI('/hooks', 'post', {
        'site_id': siteId,
        'type': 'url',
        'event': eventName,
        'data': {
            'url': `${webhookHostname}/project/${project.id}/webhook/netlify`
        }
    }, netlifyToken);
}

function getWebhooksForStackbit(project, siteId, netlifyToken) {
    let webhookHostname = config.server.webhookHostname;
    return netlifyAPI('/hooks', 'get', {
        'site_id': siteId,
        'data': {
            'url': `${webhookHostname}/project/${project.id}/webhook/netlify`
        }
    }, netlifyToken);
}

function deleteWebhooksForStackbit(project, hookId, netlifyToken) {
    return netlifyAPI(`/hooks/${hookId}`, 'delete', {}, netlifyToken);
}

function createWebooksForStackbit(project, siteId, netlifyToken) {
    return Promise.all([
        createWebhooksForStackbit(project, 'deploy_created', siteId, netlifyToken),
        createWebhooksForStackbit(project, 'deploy_failed', siteId, netlifyToken),
        createWebhooksForStackbit(project, 'deploy_building', siteId, netlifyToken)
    ]);
}

function deleteWebooksForStackbit(project, siteId, netlifyToken) {
    return getWebhooksForStackbit(project, siteId, netlifyToken).then(webhooks => {
        let webhookHostname = config.server.webhookHostname;
        webhooks = webhooks.filter(({ data: { url } }) => url === `${webhookHostname}/project/${project.id}/webhook/netlify`);
        return Promise.all(webhooks.map((({id}) => {
            return deleteWebhooksForStackbit(project, id, netlifyToken);
        })));
    });
}

function createSite(project, {isAnon, isShared, userId}, netlifyPublicKey, netlifyToken, buildLogger, retry = 0, retryName = null) {
    const repoId = project?.wizard?.repository?.id;
    const repoDetails = project?.deploymentData?.[repoId];
    const options = {
        name: projectUtils.uniqueAlphanumericName(project, retryName || project.name),
        repo: {
            repo: repoDetails.fullName,
            id: repoDetails.id,
            private: repoDetails.private,
            provider: project?.wizard?.repository?.id,
            branch: repoDetails?.defaultBranch ?? 'master',
            deploy_key_id: netlifyPublicKey.id
        }
    };

    let accountSlug = '';
    if (isShared) {
        options.session_id = `${userId}/${project.id}`;
        options.custom_domain = `${options.name}.${config.netlify.shared.domain}`;
        accountSlug = '/' + config.netlify.shared.accountSlug;
    } else if (isAnon) {
        options.session_id = userId;
        accountSlug = '/' + config.netlify.anonAccountSlug;
    }

    let env = project.getUserEnvironment() || {};

    const themeConfig = _.get(project, 'wizard.theme.settings.themeConfig');
    if (_.get(themeConfig, 'import')) {
        buildLogger.debug('Netlify: setting custom import build settings');
        const cmsImportType = _.get(themeConfig, 'import.type');
        if (!['contentful', 'sanity'].includes(cmsImportType)) {
            throw new Error(`CMS Import Error: import.type not supported: ${cmsImportType}`);
        }
        const customImportEnvVars = getCMSService().baseCustomImportEnvVars(project);
        env = Object.assign(env, customImportEnvVars);
        const buildCommand = _.get(themeConfig, 'buildCommand');
        if (buildCommand) {
            options.repo.cmd =  buildCommand;
        }
        const publishDir = _.get(themeConfig, 'publishDir');
        if (publishDir) {
            options.repo.dir =  publishDir;
        }
    } else {
        buildLogger.debug('Netlify: Adding cms env variables to build settings');
        env = Object.assign(env, getCMSService().baseEnvForDeployment(project));
        const apiKey = project.APIKeys.find(key => ['stackbit-api-key', 'container-key'].includes(key.name));
        if (apiKey) {
            buildLogger.debug('Netlify: Adding build API KEY to build settings');
            env = Object.assign(env, {
                STACKBIT_API_KEY: apiKey.key
            });
        }

        if (projectUtils.isV2Supported(project)) {
            buildLogger.debug('Netlify: Adding build v2 KEYs to build settings');

            const deploymentId = project?.wizard?.deployment?.id;
            const contactFormSecret = project.getDeploymentData(`${deploymentId}.contactFormSecret`);

            const apiHostName = config.env === 'local' ? config.server.webhookHostname : config.server.hostname;
            env = Object.assign(env, {
                STACKBIT_CONTACT_FORM_SECRET: contactFormSecret,
                STACKBIT_CONTACT_FORM_SUBMISSION_URL: new URL(`project/${project.id}/submission-created`, apiHostName).toString(),
                AWS_LAMBDA_JS_RUNTIME: 'nodejs14.x',
            });
        }
    }

    if (_.get(project, 'deploymentData.sanity.studioKey')) {
        buildLogger.debug('Netlify: Adding Sanity studio deploy key to env');
        const sanityStudioKey = _.get(project, 'deploymentData.sanity.studioKey');
        env = Object.assign(env, {
            SANITY_AUTH_TOKEN: sanityStudioKey
        });
    }

    _.set(options, 'repo.env', env);

    return netlifyAPI(`${accountSlug}/sites`, 'post', options, netlifyToken).catch(err => {
        if (err.name === 'NetlifyDomainTaken') {
            if (retry < 3) {
                const copyName = projectUtils.duplicateProjectName(retryName || project.name);
                buildLogger.debug('Netlify: Warning: NetlifyDomainTaken, retrying with copy-name', {copyName: copyName});
                return createSite(project, {isAnon, isShared, userId}, netlifyPublicKey, netlifyToken, buildLogger, retry + 1, copyName);
            }

            if (retry < 4) {
                const copyName = projectUtils.duplicateProjectName(retryName || project.name, true);
                buildLogger.debug('Netlify: Warning: NetlifyDomainTaken, retrying with random-name', {copyName: copyName});
                return createSite(project, {isAnon, isShared, userId}, netlifyPublicKey, netlifyToken, buildLogger, retry + 1, copyName);
            }

            buildLogger.debug('Netlify: Error: NetlifyDomainTaken, Retried 4 times, failing', {projectName: project.name});
            throw err;
        }

        buildLogger.debug('Netlify: Error: Cannot create site', {error: err});
        throw err;
    });
}

function importNetlifySite(project, siteId, netlifyToken, widgetInjectionFlag, buildLogger) {
    return getSite(siteId, netlifyToken).then(netlifySite=>{
        return createWebooksForStackbit(project, siteId, netlifyToken).then(()=>{
            return createBuildHookForStackbit(siteId, netlifyToken, 'master', buildLogger).then(buildHook => {
                return createWidgetSnippet(project, siteId, netlifyToken, widgetInjectionFlag).then(() => {
                    return {netlifySite, buildHook};
                });
            });
        });
    });
}

function upgradeStackbitSiteWithWidget(project, user, netlifyToken, widgetInjectionFlag) {
    const siteId = _.get(project, 'deploymentData.netlify.id');
    return createWidgetSnippet(project, siteId, netlifyToken, widgetInjectionFlag).then(()=>{
        return Project.updateProject(project.id, {'widget.netlifyInject': true}, user.id).then((project)=> {
            return Project.updateSiteUrl(project.id, project.siteUrl);
        });
    });
}

function removeNetlifySite(project, siteId, netlifyToken, widgetInjectionFlag) {
    return deleteWebooksForStackbit(project, siteId, netlifyToken).then(() => {
        return deleteBuildHooksForStackbit(siteId, netlifyToken).then(() => {
            return deleteSnippet(siteId, netlifyToken, widgetInjectionFlag);
        });
    });
}

function getSite(siteId, netlifyToken) {
    return netlifyAPI(`/sites/${siteId}`, 'get', null, netlifyToken);
}

function getSites(netlifyToken) {
    return netlifyAPI('/sites', 'get', null, netlifyToken);
}

function getSiteDeploys(siteId, netlifyToken) {
    return netlifyAPI(`/sites/${siteId}/deploys`, 'get', null, netlifyToken);
}

function createWidgetSnippet(project, siteId, netlifyToken, widgetInjectionFlag = false) {
    if (!config.build.stackbitWidget.enabled && !widgetInjectionFlag) {
        return Promise.resolve();
    }
    const widgetUrl = config.build.stackbitWidget.widgetUrl;

    return getSnippets(siteId, netlifyToken).then(snippets => {
        if (_.find(snippets, { title: SNIPPET_TITTLE })) {
            return Promise.resolve();
        }

        return createSnippet(
            siteId,
            netlifyToken,
            `<script src="${widgetUrl}" id="stackbit-widget-init" data-stackbit-project-id="${project.id}"></script>`,
            SNIPPET_TITTLE
        );
    });
}

function createSnippet(siteId, netlifyToken, body, title) {
    return netlifyAPI(`/sites/${siteId}/snippets`, 'post', {
        general: body,
        general_position: 'footer',
        title: title
    }, netlifyToken);
}

function getSnippets(siteId, netlifyToken) {
    return netlifyAPI(`/sites/${siteId}/snippets`, 'get', {}, netlifyToken);
}

function deleteSnippet(siteId, netlifyToken, snippetTitle) {
    return getSnippets(siteId, netlifyToken).then(snippets => {
        snippets = snippets.filter(({ title }) => title === snippetTitle);
        return Promise.all(snippets.map(({ id }) => {
            return netlifyAPI(`/sites/${siteId}/snippets/${id}`, 'delete', {}, netlifyToken);
        }));
    });
}

function deleteSite(project, netlifyToken) {
    const siteDetails = _.get(project, 'deploymentData.netlify');
    if (!siteDetails) {
        throw new Error('Can\'t delete - Netlify deployment details not found');
    }
    return netlifyAPI(`/sites/${siteDetails.id}`, 'delete', null, netlifyToken)
        .catch((err) => {
            if (err && err.code === 404) {
                return true; // if site was already deleted
            }
            throw err;
        });
}

/*
How to create a Netlify site - Reverse engineer edition:

1. Request a public key from netlify for creating a deploy key in github (POST: https://api.netlify.com/api/v1/deploy_keys)
req:none, res: id, public_key(ssh-rsa...), created_at
2. Create deploy keys on github by sending the key from the previous call.
req: key(ssh-rsa...), title, read_only:true (?). res: id, key, read_only, title, url, verified(bool), created_at
3. post to netlify create_site with a repo param
req: repo {id, repo(author/name), provider("github")), private(bool), deploy_key_id(hash), branch("master") }
4. create hooks for netlify on github api
req: name, active(bool), events(arr["delete","push","pull_request"]), config(obj{content_type)"json"), url("https://api.netlify.com/hooks/github"), res: -
5. 3 calls - register hooks on netlify api (type: github_commit_status) for deploy_created, deploy_failed, and deploy_building
This is a netlify hook that adds a little "build failed" or "build succeeded" icon to commits in PR's and such.
 */

function createSiteWithRepository(project, {isAnon, isShared, userId}, publicKey, netlifyToken, buildLogger) {
    buildLogger.debug('Netlify: creating netlify site');
    return createSite(project, {isAnon, isShared, userId}, publicKey, netlifyToken, buildLogger).then(site => {
        buildLogger.debug('Netlify: creating netlify webhooks for stackbit');
        return createWebooksForStackbit(project, site.id, netlifyToken).then(() => {
            buildLogger.debug('Netlify: creating widget snippet');
            return createWidgetSnippet(project, site.id, netlifyToken).then(()=> {
                buildLogger.debug('Netlify: site created', {siteId: site.id});
                return site;
            });
        });
    });
}

function updateProjectFromNetlifySiteOrDeploy(netlifySiteOrDeploy, project) {
    const deployAdminUrl = _.get(netlifySiteOrDeploy, 'admin_url');
    const projectAdminUrl = _.get(project, 'deploymentData.netlify.url');
    const adminUrlChanged = deployAdminUrl && projectAdminUrl !== deployAdminUrl;

    const deploySiteUrl = _.get(netlifySiteOrDeploy, 'ssl_url');
    const projectSiteUrl = _.get(project, 'siteUrl');
    const siteUrlChanged = deploySiteUrl && projectSiteUrl !== deploySiteUrl;

    if (adminUrlChanged || siteUrlChanged) {
        const siteUrl = deploySiteUrl.toLowerCase();
        const adminUrl = deployAdminUrl.toLowerCase();
        const host = new URL(siteUrl).origin;
        const allowedHosts = _.get(project, 'allowedHosts', []);

        _.set(project, 'deploymentData.netlify.url', adminUrl);
        _.set(project, 'siteUrl', siteUrl);
        _.set(project, 'deploymentData.netlify.nameChanged', _.get(netlifySiteOrDeploy, 'name'));
        _.set(project, 'metrics.didChangeNetlifyName', true);
        _.set(project, 'allowedHosts', [...(new Set([host, ...allowedHosts]))]);

        const cms = _.get(project, 'wizard.cms.id');
        if (cms === 'netlifycms' && _.get(project, 'deploymentData.netlifycms')) {
            _.set(project, 'deploymentData.netlifycms.url', `${siteUrl}/admin`);
        }

        return Project.updateProject(project.id, project, project.ownerId);
    }

    return Promise.resolve(project);
}

function setEnvironmentVariables(siteId, netlifyToken, env) {
    return getSite(siteId, netlifyToken).then(netlifySite => {
        return netlifyAPI(`/sites/${siteId}`, 'put', {
            build_settings: {
                env: {
                    ...(_.get(netlifySite, 'build_settings.env', {})),
                    ...env
                }
            }
        }, netlifyToken);
    });
}

function deleteEnvironmentVariables(siteId, netlifyToken, vars) {
    return getSite(siteId, netlifyToken).then(netlifySite => {
        return netlifyAPI(`/sites/${siteId}`, 'put', {
            build_settings: {
                env: {
                    ...(_.omit(_.get(netlifySite, 'build_settings.env', {}), vars))
                }
            }
        }, netlifyToken);
    });
}

function enableBranches(siteId, netlifyToken) {
    return netlifyAPI(`/sites/${siteId}`, 'put', {
        build_settings: {
            allowed_branches: []
        }
    }, netlifyToken);
}

function startSplitTest(siteId, netlifyToken, splitTest) {
    logger.debug('Netlify: starting split test');
    return netlifyAPI(`/sites/${siteId}/traffic_splits`, 'post', {
        branch_tests: {
            ...splitTest
        }
    }, netlifyToken);
}

function resumeSplitTest(siteId, netlifyToken, splitTestId) {
    return netlifyAPI(`/sites/${siteId}/traffic_splits/${splitTestId}/publish`, 'post', null, netlifyToken);
}

function stopSplitTest(siteId, netlifyToken, splitTestId) {
    return netlifyAPI(`/sites/${siteId}/traffic_splits/${splitTestId}/unpublish`, 'post', null, netlifyToken).then(res => console.log(res));
}

function updateSplitTest(siteId, netlifyToken, splitTest, splitTestId) {
    return netlifyAPI(`/sites/${siteId}/traffic_splits/${splitTestId}`, 'put', {
        branch_tests: {
            ...splitTest
        }
    }, netlifyToken);
}

module.exports = {
    netlifyAPI,
    createPublicKey,
    claimAnonNetlifySites,
    getAnonClaimToken,
    getSharedClaimToken,
    createSiteWithRepository,
    createBuildHookForStackbit,
    deleteBuildHooksWithUrls,
    setEnvironmentVariables,
    deleteEnvironmentVariables,
    importNetlifySite,
    upgradeStackbitSiteWithWidget,
    removeNetlifySite,
    getUser,
    getSite,
    getSites,
    getSiteDeploys,
    createSnippet,
    getSnippets,
    deleteSnippet,
    hasRestrictedWebhooks,
    deleteSite,
    validateAccessToken,
    updateProjectFromNetlifySiteOrDeploy,
    enableBranches,
    startSplitTest,
    resumeSplitTest,
    stopSplitTest,
    updateSplitTest
};
