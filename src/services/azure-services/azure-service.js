const _ = require('lodash');
const yml = require('js-yaml');
const { join } = require('path');
const { readdir, writeFile, readFile } = require('fs-extra');
const { WebSiteManagementClient } = require('@azure/arm-appservice');
const { ResourceManagementClient } = require('@azure/arm-resources');
const { TokenCredentials } = require('@azure/ms-rest-js');
const { SubscriptionClient } = require('@azure/arm-subscriptions');
const { AuthenticationContext } = require('adal-node');
const { getStackbitYamlFromProjectInfo } = require('../deploy-services/factory-service');
const gitService = require('../deploy-services/git-service');

const config = require('../../config').default;
const logger = require('../logger');

const resourceProviderNamespaces = [
    'Microsoft.Automation',
    'Microsoft.Web',
    'Microsoft.Insights',
];

const supportedSSGs = ['gatsby', 'hugo', 'nextjs'];

async function createSiteWithRepository(project, { repositoryToken, azureAccessToken, buildLogger }) {
    const repoId = project.wizard.repository.id;
    const hostingPlanName = project.getDeploymentData('azure.hostingPlanName');
    const resourceGroupName = project.getDeploymentData('azure.resourceGroupName');
    const sku = project.getDeploymentData('azure.sku');
    const location = project.getDeploymentData('azure.location');

    const client = await getWebsiteManagementClient(project, azureAccessToken);
    const { publishDir, buildCommand } = await getStackbitYamlFromProjectInfo(project);

    const parameters = {
        serverFarmId: hostingPlanName,
        repositoryUrl: project.getDeploymentData(`${repoId}.url`),
        repositoryToken: repositoryToken,
        branch: project.getDeploymentData(`${repoId}.defaultBranch`),
        location,
        sku,
        buildProperties : {
            appArtifactLocation: publishDir
        }
    };
    await enableResourceProviders(project, azureAccessToken);
    await createOrUpdateResource(project, azureAccessToken);
    const site = await client.staticSites.createOrUpdateStaticSite(resourceGroupName, project.name, parameters, null);

    const { publishBranch, previewBranch } = project.getContainerBranches();
    const outputDir = project.getDeploymentData('build.outputDir');
    await gitService.syncBranchesWithRemote(outputDir, buildLogger, { branches: [previewBranch, publishBranch] });

    await addBuildCommand(project, buildCommand, buildLogger);

    // after site is created on Azure, Azure creates Github workflow yml
    // it have to be synced with preview branch
    await gitService.mergeFromTo(outputDir, buildLogger, {
        fromBranch: publishBranch,
        toBranch: previewBranch
    });

    return site;
}

async function updateManagedApplicationSiteRepository(project, { repositoryToken, azureAccessToken, buildLogger }) {
    const repoId = project.wizard.repository.id;
    const deploymentData = project.deploymentData.azure;
    const resourceGroupName = project.wizard.deployment.settings?.managedResourceGroupId;
    const client = await getWebsiteManagementClient(project, azureAccessToken);
    const sites = await client.staticSites.getStaticSitesByResourceGroup(resourceGroupName);
    const { publishDir, buildCommand } = await getStackbitYamlFromProjectInfo(project);

    let initialSite = sites.find(site => {
        // initial site always deployed from stackbithq/azure-marketplace-starter-static-web-app repo
        return site.repositoryUrl === config.azure.starterRepoUrl;
    });

    // if marketplace app deployed and user was fast
    // and in next couple of minutes tries to deploy new site to the managed resource group
    // Azure will not return sites in resource group, it needs couple of minutes of waiting to provision all cloud infra
    // hence use default
    if (!initialSite) {
        initialSite = {
            location: deploymentData.location,
            sku: deploymentData.sku,
        }
    }

    const parameters = {
        ...initialSite,
        repositoryUrl: project.getDeploymentData(`${repoId}.url`),
        repositoryToken,
        branch: project.getDeploymentData(`${repoId}.defaultBranch`),
        buildProperties : {
            appArtifactLocation: publishDir
        }
    };

    const site = await client.staticSites.createOrUpdateStaticSite(resourceGroupName, project.name, parameters, null);

    const { publishBranch, previewBranch } = project.getContainerBranches();
    const outputDir = project.getDeploymentData('build.outputDir');
    await gitService.syncBranchesWithRemote(outputDir, buildLogger, { branches: [previewBranch, publishBranch] });

    await addBuildCommand(project, buildCommand, buildLogger);

    // after site is created on Azure, Azure creates Github workflow yml
    // it have to be synced with preview branch
    await gitService.mergeFromTo(outputDir, buildLogger, {
        fromBranch: publishBranch,
        toBranch: previewBranch
    });

    return site;
}

// app_build_command described via documentation but isn't supported by SDK
// hence it's patched directly on github
// https://docs.microsoft.com/en-us/azure/static-web-apps/github-actions-workflow#custom-build-commands
// Note: for Hugo app_build_command is ignored
async function addBuildCommand(project, buildCommand, buildLogger) {
    const outputDir = project.getDeploymentData('build.outputDir');
    const workflowsPath = join(outputDir, '.github/workflows');
    const workflows = await readdir(workflowsPath);
    const azureWorkflows = workflows.filter(workflow => workflow.startsWith('azure-static-web-apps'));
    await Promise.all(azureWorkflows.map(async workflowFile => {
        const workflowFilePath = join(workflowsPath, workflowFile);
        const workflowYamlFile = await readFile(workflowFilePath, 'utf8');
        const data = yml.safeLoad(workflowYamlFile, {schema: yml.JSON_SCHEMA});
        const steps = _.get(data, 'jobs.build_and_deploy_job.steps');
        const builddeployStep = _.find(steps, { id: 'builddeploy' });
        _.set(builddeployStep, 'with.app_build_command', project.wizard.settings.enableWidget ? './stackbit-build.sh' : buildCommand);
        const dump = yml.safeDump(data, {noRefs: true});
        return writeFile(workflowFilePath, dump);
    }));
    return gitService.commitChanges(outputDir, 'Add build command', buildLogger);
}

async function createOrUpdateResource(project, azureAccessToken) {
    const resourceGroupName = project.getDeploymentData('azure.resourceGroupName');
    const location = project.getDeploymentData('azure.location');
    const client = await getResourceManagementClient(project, azureAccessToken);

    const resourceGroups = await client.resourceGroups.list();

    if (!_.find(resourceGroups, (({ name }) => name === resourceGroupName) )) {
        await client.resourceGroups.createOrUpdate(resourceGroupName, { location });
    }
}

async function enableResourceProviders(project, azureAccessToken) {
    const client = await getResourceManagementClient(project, azureAccessToken);

    const resources = await client.providers.list();
    if (!_.find(resources, (({ name }) => resourceProviderNamespaces.includes(name)) )) {
        return Promise.all(resourceProviderNamespaces.map(resourceProviderNamespace => client.providers.register(resourceProviderNamespace)));
    }
}

// used sample from
// https://github.com/AzureAD/azure-activedirectory-library-for-nodejs/blob/023fb2e3913e522091368c58d473b0042e6d0c74/sample/refresh-token-sample.js#L73
function refreshToken(user) {
    logger.debug('Azure: refreshing access token');
    const azureConnection = _.find(user.connections, { type: 'azure' });
    const tenantId = azureConnection?.settings?.tenantIdOrName;
    const azureConfig = config.azure;
    const loginUrl = new URL(tenantId, config.azure.loginUrl);
    const authContext = new AuthenticationContext(loginUrl.toString());
    return new Promise((resolve, reject) => {
        authContext.acquireTokenWithRefreshToken(
            azureConnection.refreshToken,
            azureConfig.clientId,
            azureConfig.clientSecret,
            azureConfig.resourceManagementUrl,
            function (error, result) {
                if (error) {
                    logger.error('Azure: error refreshing access token', error);
                    return user.removeConnection('azure')
                        .then(resolve)
                        .catch(reject);
                } else {
                    return user.addConnection('azure', { accessToken: result.accessToken, refreshToken: result.refreshToken })
                        .then(resolve)
                        .catch(reject);
                }
            });
    });
}

// used sample from
// https://github.com/AzureAD/azure-activedirectory-library-for-nodejs/blob/023fb2e3913e522091368c58d473b0042e6d0c74/sample/client-credentials-sample.js#L84
function getTokenWithClientCredentials(user, { resource }) {
    logger.debug('Azure: get access token with client credentials');
    const azureConfig = config.azure;
    const loginUrl = new URL(azureConfig.tenantId, config.azure.loginUrl);
    const authContext = new AuthenticationContext(loginUrl.toString());
    return new Promise((resolve, reject) => {
        authContext.acquireTokenWithClientCredentials(
            resource,
            azureConfig.clientId,
            azureConfig.clientSecret,
            function (error, result) {
                if (error) {
                    logger.error('Azure: error get access token with client credentials', error);
                    throw reject(error);
                } else {
                    return resolve(result.accessToken);
                }
            });
    });
}

async function getSubscriptionId(project, azureAccessToken) {
    const subscriptionId = project.wizard.deployment.settings?.subscriptionId;

    if (subscriptionId) {
        return subscriptionId;
    }

    const credentials = new TokenCredentials(azureAccessToken);
    const client = new SubscriptionClient(credentials);
    const availableSubscriptions = await client.subscriptions.list();
    const enabledSubscription = _.find(availableSubscriptions, { state: 'Enabled' });

    return enabledSubscription?.subscriptionId;
}

function updateProjectDeploymentData(project) {
    // @todo handle build statuses with state machine
    return Promise.resolve(project);
}

async function deleteSite(project, azureAccessToken) {
    const client = await getWebsiteManagementClient(project, azureAccessToken);
    const resourceGroupName = project.wizard.deployment.settings?.managedResourceGroupId || project.getDeploymentData('azure.resourceGroupName');

    // removing process on Azure side is async
    // users might experiance that after removing from Stackbit site is present for couple of minutes on Azure Portal
    return client.staticSites.deleteStaticSite(resourceGroupName, project.name);
}

async function getResourceManagementClient(project, azureAccessToken) {
    const subscriptionId = await getSubscriptionId(project, azureAccessToken);
    const credentials = new TokenCredentials(azureAccessToken);
    return new ResourceManagementClient(credentials, subscriptionId);
}

async function getWebsiteManagementClient(project, azureAccessToken) {
    const subscriptionId = await getSubscriptionId(project, azureAccessToken);
    const credentials = new TokenCredentials(azureAccessToken);
    return new WebSiteManagementClient(credentials, subscriptionId);
}

module.exports = {
    refreshToken,
    createSiteWithRepository,
    getSubscriptionId,
    updateProjectDeploymentData,
    deleteSite,
    getTokenWithClientCredentials,
    updateManagedApplicationSiteRepository,
    supportedSSGs
};
