const _ = require('lodash');
const axios = require('axios');
const crypto = require('crypto');

const config = require('../../config').default;
const logger = require('../logger');
const Project = require('../../models/project.model').default;
const netlifyService = require('../netlify-services/netlify-service');
const environmentsService = require('./environments-service');
const publishContentService = require('./publish-content-service');
const responseErrors = require('../../routers/response-errors');
const containerService = require('./container-service');

const SNIPPET_TITLE = 'analytics';

async function getNetlifyAccessToken(user) {
    let {netlifyAccessToken} = user;
    const isTokenValid = await netlifyService.validateAccessToken(netlifyAccessToken);
    if (!isTokenValid && config.netlify.anonFlowEnabled) {
        netlifyAccessToken = config.netlify.anonAccessToken;
    }
    return netlifyAccessToken;
}

function injectAnalyticsToNetlify(project, user, siteId, netlifyAccessToken, options) {
    if (!options.analytics) {
        return Promise.resolve(project);
    }
    const variantsMap = {};
    options.variants.forEach(variant => {
        variantsMap[variant.environment || 'master'] = variant.name;
    });
    return netlifyService.getSite(siteId, netlifyAccessToken).then(site => {
        const env = _.get(site, 'build_settings.env', {});
        env['GA_TRACKING_ID'] = _.get(options, 'analytics.trackingId');
        env['GA_DIMENSION_INDEX'] = _.get(options, 'analytics.dimensionIndex');
        env['GA_VARIANTS'] = JSON.stringify(variantsMap);
        return netlifyService.setEnvironmentVariables(siteId, netlifyAccessToken, env);
    }).then(() => {
        const body = `
        <script async src="https://www.googletagmanager.com/gtag/js?id={{ GA_TRACKING_ID }}"></script>
        <script>
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          const variants = JSON.parse('{{ GA_VARIANTS }}');
          gtag('config', '{{ GA_TRACKING_ID }}', {'dimension{{ GA_DIMENSION_INDEX }}': variants['{{ BRANCH }}']});
        </script>
        `;
        //TODO delete if exists
        return netlifyService.createSnippet(siteId, netlifyAccessToken, body, SNIPPET_TITLE);
    }).then(() => project);
}

function removeAnalyticsFromNetlify(project, user, siteId, netlifyAccessToken) {
    return netlifyService.deleteSnippet(siteId, netlifyAccessToken, SNIPPET_TITLE).then(() => {
        return netlifyService.deleteEnvironmentVariables(siteId, netlifyAccessToken, ['GA_TRACKING_ID', 'GA_DIMENSION_INDEX', 'GA_VARIANTS']);
    }).then(() => project);
}

function registerNetlifyBranches(project, user, siteId, token, environments) {
    return netlifyService.enableBranches(siteId, token).then(() => {
        return Promise.all(
            environments.map(env => {
                return netlifyService.createBuildHookForStackbit(siteId, token, env, logger).then(hook => {
                    return Project.updateDeploymentData(project.id, 'netlify', {
                        buildHookUrl: hook.url
                    }, env);
                });
            })
        );
    });
}

async function provisionSplitTest(project, user, params, res) {
    logger.info('[split-test] provisioning', {projectId: project.id, params});
    const splitTest = _.get(project, 'splitTests[0]', {});
    if (splitTest.status && splitTest.status !== 'provisioned') {
        throw responseErrors.UnsupportedOperation;
    }
    splitTest.status = 'provisioned';
    splitTest.variants = splitTest.variants || [];
    const variantsById = _.keyBy(splitTest.variants, '_id');
    const netlifySiteId = _.get(project, 'deploymentData.netlify.id');
    const netlifyAccessToken = await getNetlifyAccessToken(user);

    // update analytics info
    if (!_.isEmpty(params.analytics)) {
        logger.info('[split-test] provisioning: setting analytics', {projectId: project.id});
        splitTest.analytics = params.analytics;
    }
    // remove variants if needed
    if (!_.isEmpty(params.removeVariants)) {
        const environmentsToRemove = params.removeVariants.map(variantId => _.get(variantsById[variantId], 'environment')).filter(Boolean);

        const buildHooksUrls = environmentsToRemove.map(environmentName => project.getDeploymentData('netlify.buildHookUrl', environmentName));
        logger.info('[split-test] removing build hooks', {projectId: project.id, buildHooksUrls});
        await netlifyService.deleteBuildHooksWithUrls(netlifySiteId, netlifyAccessToken, buildHooksUrls);
        await Promise.all(environmentsToRemove.map(environmentName => Project.updateDeploymentData(project.id, 'netlify', {
            buildHookUrl: null
        }, environmentName)));

        logger.info('[split-test] provisioning: removing variants', {projectId: project.id, variants: params.removeVariants, environmentsToRemove});
        splitTest.variants = splitTest.variants.filter(variant => !environmentsToRemove.includes(variant.environment));
        await environmentsService.removeEnvironments(project, user, environmentsToRemove);
    }
    // update existing variants
    if (!_.isEmpty(params.updateVariants)) {
        Object.keys(params.updateVariants).forEach(variantId => {
            const variant = variantsById[variantId];
            if (!variant) {
                return;
            }
            variant.name = params.updateVariants[variantId].name;
            variant.split = params.updateVariants[variantId].split;
        });
    }
    // add new variants
    const newEnvironments = [];
    if (!_.isEmpty(params.addVariants)) {
        params.addVariants.forEach((variant, i) => {
            if (splitTest.variants.length + i === 0) {
                splitTest.variants.push(variant);
            } else {
                const environmentName = `env-${crypto.randomBytes(4).toString('hex').substr(0,5)}`;
                newEnvironments.push(environmentName);
                splitTest.variants.push({
                    name: variant.name,
                    split: variant.split,
                    environment: environmentName
                });
            }
        });
    }

    // provision new environments
    if (!project.checkTierAllowanceForFeature('environments', { requiredAmount: newEnvironments.length })) {
        throw responseErrors.ProjectTierExceeded;
    }

    project = await Project.setSplitTest(project.id, splitTest);
    res.json(project); // return response

    // provision new environments
    if (!_.isEmpty(newEnvironments)) {
        logger.info('[split-test] provisioning environments', {projectId: project.id, newEnvironments});
        return environmentsService.createEnvironments(project, user, newEnvironments).then(project => {
            logger.info('[split-test] registering branches', {projectId: project.id});
            return registerNetlifyBranches(project, user, netlifySiteId, netlifyAccessToken, newEnvironments);
        }).then(() => Project.findById(project.id)).catch(err => {
            logger.error('[split-test] failed to provision', {projectId: project.id, err: _.get(err, 'message', err)});
            splitTest.status = 'failed';
            return Project.setSplitTest(project.id, splitTest);
        });
    }

    return Promise.resolve(project);
}

function startSplitTest(project, user, params, res) {
    const splitTest = _.get(project, 'splitTests[0]');
    if (!splitTest) {
        throw responseErrors.SplitTestNotFound;
    } else if (splitTest.status !== 'provisioned') {
        throw responseErrors.UnsupportedOperation;
    }
    logger.info('[split-test] starting', {projectId: project.id});
    res.json(project);
    const environments = splitTest.variants.map(variant => variant.environment);
    const envHasChanges = {};
    return Promise.all(
        environments.map(environmentName => {
            return require('./cmss').baseInvokeContentSourcesWithProject('hasChanges', project, user, { objects: [], type: 'all' }, environmentName).then(result => {
                envHasChanges[environmentName] = result.hasChanges;
            }).catch(err => {
                logger.warn('[split-test] error getting changes from environment', {environmentName, err, projectId: project.id});
            });
        })
    ).then(() => {
        logger.info('[split-test] publishing branches', {projectId: project.id, envHasChanges});
        return Promise.all(
            environments.map(environmentName => {
                if (envHasChanges[environmentName]) {
                    logger.debug('[split-test] publishing content for: ' + environmentName, {projectId: project.id});
                    return publishContentService.publishContent(project, user, { objects: [], type: 'all' }, environmentName);
                } else if (environmentName) {
                    logger.debug('[split-test] triggering hook for: ' + environmentName, {projectId: project.id});
                    return axios.post(project.getDeploymentData('netlify.buildHookUrl', environmentName));
                }
                return Promise.resolve();
            })
        );
    }).then(() => Project.findById(project.id)).then(project => {
        splitTest.status = 'starting';
        return Project.setSplitTest(project.id, splitTest);
    });
}

function continueStartSplitTest(project, user, splitTest) {
    const possibleEnvironments = splitTest.variants.map(variant => variant.environment).filter(Boolean);
    const liveEnvironments = _.map(possibleEnvironments, (environmentName) => {
        return project.getDeploymentData('netlify.buildProgress', environmentName, null, false) === 'live'
            ? environmentName
            : null;
    });
    if (!liveEnvironments || !_.every(liveEnvironments)) {
        logger.info('[split-test] waiting for start', {projectId: project.id, liveEnvironments});
        return Promise.resolve(project);
    }
    logger.info('[split-test] finish starting', {projectId: project.id});
    const branchTests = {};
    splitTest.variants.forEach(variant => {
        branchTests[variant.environment || 'master'] = variant.split;
    });
    return getNetlifyAccessToken(user).then((netlifyAccessToken) => {
        const siteId = _.get(project, 'deploymentData.netlify.id');
        return injectAnalyticsToNetlify(project, user, siteId, netlifyAccessToken, splitTest).then(project => {
            return netlifyService.startSplitTest(siteId, netlifyAccessToken, branchTests).then(netlifySplitTest => {
                const netlifySplitTestId = _.get(netlifySplitTest, 'id');
                logger.info('[split-test] split test started', {projectId: project.id, netlifySplitTestId});
                if (netlifySplitTestId) {
                    splitTest.status = 'running';
                    splitTest.netlifySplitTestId = netlifySplitTestId;
                    return Project.setSplitTest(project.id, splitTest);
                }
                return project;
            });
        });
    });
}

function finishSplitTest(project, user, {selectedVariant}, res) {
    const splitTest = _.get(project, 'splitTests[0]');
    if (!splitTest) {
        throw responseErrors.SplitTestNotFound;
    } else if (!['running','provisioned'].includes(splitTest.status)) {
        throw responseErrors.UnsupportedOperation;
    }
    const variant = _.find(splitTest.variants, (variant) => variant._id == selectedVariant);
    if (!variant) {
        throw responseErrors.SplitTestVariantNotFound;
    }
    logger.info('[split-test] finishing', {projectId: project.id, splitTest});
    splitTest.status = 'finishing';
    return Project.setSplitTest(project.id, splitTest).then(project => {
        res.json(project); // return response
        if (!variant.environment) {
            return cleanupSplitTest(project, user);
        }
        return environmentsService.pickEnvironment(project, user, variant.environment).then(project => {
            if (_.get(project, 'wizard.cms.id') === 'git') { //TODO check for gitbased instead
                logger.debug('[split-test] pulling changes on container', {projectId: project.id});
                return containerService.pull(project, user);
            } else {
                logger.debug('[split-test] triggering hook for master', {projectId: project.id});
                return axios.post(project.getDeploymentData('netlify.buildHookUrl'));
            }
        });
    }).then(project => {
        logger.info('[split-test] done picking environment', {projectId: project.id, environment: variant.environment});
        return project;
    }).catch(err => {
        logger.error('[split-test] failed to finish test', {projectId: project.id, err: _.get(err, 'message', err)});
        splitTest.status = 'failed';
        return Project.setSplitTest(project.id, splitTest);
    });
}

function cleanupSplitTest(project, user, params, res) {
    logger.info('[split-test] cleaning up', {projectId: project.id});
    const splitTest = _.get(project, 'splitTests[0]');
    if (!splitTest) {
        return Promise.resolve(project);
    }
    const environments = splitTest.variants.map(variant => variant.environment).filter(Boolean);
    return getNetlifyAccessToken(user).then((netlifyAccessToken) => {
        const siteId = _.get(project, 'deploymentData.netlify.id');
        return Promise.resolve().then(() => {
            if (splitTest.netlifySplitTestId) {
                const branchTests = {};
                splitTest.variants.forEach(variant => {
                    branchTests[variant.environment || 'master'] = variant.environment ? 0 : 100;
                });
                logger.info('[split-test] stopping netlify split test', {projectId: project.id, netlifySplitTestId: splitTest.netlifySplitTestId});
                return netlifyService.updateSplitTest(siteId, netlifyAccessToken, branchTests, splitTest.netlifySplitTestId).then(() => {
                    setTimeout(() => {
                        netlifyService.stopSplitTest(siteId, netlifyAccessToken, splitTest.netlifySplitTestId);
                    }, 3000);
                });
            }
        }).then(() => {
            logger.info('[split-test] remove analytics', {projectId: project.id});
            return removeAnalyticsFromNetlify(project, user, siteId, netlifyAccessToken);
        }).then(() => {
            const buildHooksUrls = environments.map(environmentName => project.getDeploymentData('netlify.buildHookUrl', environmentName));
            logger.info('[split-test] removing build hooks', {projectId: project.id, buildHooksUrls});
            return netlifyService.deleteBuildHooksWithUrls(siteId, netlifyAccessToken, buildHooksUrls);
        }).then(() => {
            environments.forEach(environmentName => {
                _.set(project, `environments.${environmentName}.netlify.buildHookUrl`, null);
            });
            _.set(project, 'splitTest[0].netlifySplitTestId', null);
            return Project.updateProject(project.id, project, project.ownerId);
        });
    }).then(project => {
        return environmentsService.removeEnvironments(project, user, environments);
    }).then(project => {
        project.splitTests = [];
        return Project.updateProject(project.id, project, project.ownerId);
    }).then(() => Project.findById(project.id)).then(project => {
        if (res) {
            res.json(project);
        }
        return project;
    });
}

function continueSplitTestOperation(project, user) {
    const splitTest = _.get(project, 'splitTests[0]');
    if (!splitTest) {
        return Promise.resolve(project);
    }
    logger.info('[split-test] continue split test op', {projectId: project.id, status: splitTest.status, netlifySplitTestId: splitTest.netlifySplitTestId});
    if (splitTest.status === 'starting' && !splitTest.netlifySplitTestId) {
        logger.info('[split-test] continuing start', {projectId: project.id});
        return continueStartSplitTest(project, user, splitTest);
    } else if (splitTest.status === 'finishing' &&
               project.getDeploymentData('netlify.buildProgress') === 'live') {
        logger.info('[split-test] continuing finish', {projectId: project.id});
        return cleanupSplitTest(project, user, splitTest);
    }
}

module.exports = {
    provisionSplitTest,
    startSplitTest,
    finishSplitTest,
    continueSplitTestOperation,
    cleanupSplitTest
};
