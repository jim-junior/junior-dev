const _ = require('lodash');
const normalizeUrl = require('normalize-url');
const Project = require('../../../models/project.model').default;
const azureService = require('../../azure-services/azure-service');
const repositories = require('../repositories');
const config = require('../../../config').default;

// Plans: https://azure.microsoft.com/en-us/pricing/details/app-service/windows/
const AZURE_TIER_NAMES = {
    FREE: 'Free',
};
const LOCATION = 'centralus';

module.exports = {
    deploy: async (project, user, buildLogger) => {
        try {
            let azureSite;
            const ssgId = project.wizard.ssg.id;
            const isMarketplaceFlow = project.wizard.deployment.settings?.managedResourceGroupId;

            if (!azureService.supportedSSGs.includes(ssgId)) {
                buildLogger.debug(`Azure: SSG ${ssgId} isn't supported`);
                return null;
            }

            if (isMarketplaceFlow) {
                // @todo reverify if user actually has access to resource group after UI verification
                azureSite = await deployMarketplaceSite(user, project, buildLogger);
            } else {
                azureSite = await deploySite(user, project, buildLogger);
            }

            await repositories.callRepositoryMethodForProject('addBuildStatusWebhooks', project, user);

            const siteURL = normalizeUrl(azureSite.defaultHostname);
            const update = {
                id: azureSite.id,
                url: siteURL,
                connected: false,
                // @todo add build hookUrl for API based CMS
                // this type of deployment doesn't have any buildHookUrl
                // build is triggered by repository service automatically or calling repo API
                // it depends if CMS is APi or GitBased. Git based push changes automatically to main branch and build is triggered on each main branch push
                // for API based CMS, Stackbit API have to trigger repository via repository API,
                // e.g. Github: https://docs.github.com/en/free-pro-team@latest/actions/reference/events-that-trigger-workflows#repository_dispatch
                buildHookEnabled: true,
            };

            project = await Project.updateDeploymentData(project._id, 'build', { hasStepHooks: true });
            project = await Project.updateDeploymentData(project._id, 'azure', update);
            project = await Project.updateSiteUrl(project._id, siteURL);

            return Project.updateProject(project.id, {
                // for now it's not possible to setup build command for hugo
                // hence widget isn't injected
                'widget.netlifyInject': ssgId !== 'hugo'
            }, user.id);
        } catch (e) {
            buildLogger.error('Azure: deploy error', e);
            throw new Error('Error deploying Azure');
        }
    },
    updateProjectData: function(project, user) {
        // @todo update build status
        // used for build statuses for widget
        return Promise.resolve(project);
    },

    updateProjectDeploymentData: function (project) {
        // @todo update build status
        return Promise.resolve(project);
    },

    // @todo use state machine like for Netlify
    setDeploymentBuildProgress: function(...args) {
        return repositories.callRepositoryMethodForProject('setDeploymentBuildProgress', ...args);
    },

    /**
     * Triggers build process related to deployment or other action inside stackbit system
     * @param {Object} project
     * @param {Object} user
     * @param {Object} payload
     * @return {Object}
     */
    triggerAutoBuild: async function(project, user, payload, action) {
        // @todo when add API based CMS support
        // const autoBuildTriggerEnabled = _.get(project, 'settings.autoBuildTriggerEnabled');
        // if (!autoBuildTriggerEnabled) {
        //     logger.debug('[azure-deployment] triggerBuild(): auto build is disabled for the project, skipping build', {
        //         projectId: project.id,
        //         userId: user.id
        //     });
        //     return project;
        // }
        // return updateBuildStatusAndTriggerBuild(project, user, payload);
        await Project.updateDeploymentData(project.id, 'azure', {
            deploy_id: null,
            build_status: null,
            buildProgress: 'building',
            externalBuildLogLink: null
        });
        return Project.updateBuildStatus(project._id, 'deploying', {message: null, countDeploy: true});
    },

    /**
     * Triggers build process related to any API action
     * @param {Object} project
     * @param {Object} user
     * @param {Object} payload
     * @return {Object}
     */
    triggerBuild: async function(project, user, payload) {
        // @todo patch github workflow yaml and trigger
        await Project.updateDeploymentData(project.id, 'azure', {
            deploy_id: null,
            build_status: null,
            buildProgress: 'building',
            externalBuildLogLink: null
        });
        return Project.updateBuildStatus(project._id, 'deploying', {message: null, countDeploy: true});
    },

    createAPIKey: function(project) {
        return Project.createAPIKey(project._id, 'stackbit-api-key');
    },

    buildProject: function(project, user, buildLogger) {
        return require('../factory-service').buildProject(project, user, buildLogger);
    },

    destroy: async function(project, user, buildLogger) {
        buildLogger.debug('Azure: removing site');

        user = await azureService.refreshToken(user);
        const userConnections = user.connections || [];
        const azureAccessToken = _.find(userConnections, { type: 'azure' }).accessToken;

        return azureService.deleteSite(project, azureAccessToken);
    }
};

const deployMarketplaceSite = async (user, project, buildLogger) => {
    const azureAccessToken = await azureService.getTokenWithClientCredentials(user, { resource: config.azure.resourceManagementUrl });
    project = await Project.updateDeploymentData(project.id, 'azure', {
        location: LOCATION,
        sku: {
            name: AZURE_TIER_NAMES.FREE,
        }
    });
    return azureService.updateManagedApplicationSiteRepository(project, {
        // azure project always use transfer mechanism, using sharedUser token
        repositoryToken: config.container.shared.githubAccessToken,
        buildLogger,
        azureAccessToken
    });
};

const deploySite = async (user, project, buildLogger) => {
    /*
     * Refresh token each time user deploy site
     * Default token lifetime is 1 hour
     * https://docs.microsoft.com/en-us/azure/active-directory/develop/active-directory-configurable-token-lifetimes#configurable-token-lifetime-properties
     */
    user = await azureService.refreshToken(user);
    const userConnections = user.connections || [];
    const azureAccessToken = _.find(userConnections, { type: 'azure' }).accessToken;

    buildLogger.debug('Azure: set azure default deploymentData');

    const subscriptionId = await azureService.getSubscriptionId(project, azureAccessToken);

    const resourceGroupName = 'stackbit-resource-group';
    project = await Project.updateDeploymentData(project.id, 'azure', {
        location: LOCATION,
        sku: {
            name: AZURE_TIER_NAMES.FREE,
        },
        resourceGroupName,
        actionGroupName: 'stackbit-action-group',
        hostingPlanName: `stackbit-plan-name-${project.id}`,
        automationAccountName: 'stackbitAutomationAccountName',
        subscriptionId
    });

    buildLogger.debug('Azure: creating azure site');
    return azureService.createSiteWithRepository(project, {
        // azure project always use transfer mechanism, using sharedUser token
        repositoryToken: config.container.shared.githubAccessToken,
        azureAccessToken,
        buildLogger
    });
};
