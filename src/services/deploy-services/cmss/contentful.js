const _ = require('lodash');
const fse = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const uuid = require('uuid');
const { spawn } = require('child_process');
const gitP = require('simple-git/promise');

const fileUtils = require('../../utils/file-utils');
const { withRetry } = require('../../utils/code.utils');
const contentfulApiService = require('../../contentful-services/contentful-api-service');
const contentfulPreviewApi = require('../../contentful-services/contentful-preview-api');
const contentfulProjectService = require('../../contentful-services/contentful-project-service');
const Project = require('../../../models/project.model').default;
const CollaboratorRole = require('../../../models/collaborator-role.model').default;
const ResponseErrors = require('../../../routers/response-errors');
const logger = require('../../logger');
const factoryService = require('../factory-service');
const containerService = require('../container-service');
const analytics = require('../../analytics/analytics');
const gitbased = require('./gitbased');
const { getProcessPromise } = require('../../utils/process.utils');

module.exports = {
    preBuild: function (project, user, previewBranchName, buildLogger) {
        const contentfulConnection = _.find(user.connections, {type: 'contentful'});
        if (!contentfulConnection) {
            buildLogger.error('Contentful: Access token missing for space creation');
            throw ResponseErrors.ContentfulNotConnected;
        }

        return withRetry(() => contentfulApiService.createSpace(project, contentfulConnection.accessToken, buildLogger), { logger: buildLogger }).then(space => {
            return contentfulApiService.createPersonalAccessToken(project, space, contentfulConnection.accessToken).then(manageKey => {
                return contentfulApiService.createApiKeys(project, space, contentfulConnection.accessToken).then(apiKeys => {
                    return contentfulProjectService.addSpaceToProject(project, space, apiKeys, manageKey, false);
                }).then(project => {
                    return Project.updateDeploymentData(project._id, 'contentful', {
                        branch: previewBranchName
                    });
                });
            });
        }).catch(err => {
            contentfulApiService.deleteSpace(project, contentfulConnection.accessToken).catch((delErr) => {
                buildLogger.error('Contentful: cannot delete space', {error: delErr});
            });

            if (err.status === 403) {
                buildLogger.error('Contentful: Not authorized or exceed plan limit', err);
                throw ResponseErrors.ContentfulExceedPlan;
            }

            buildLogger.error('Contentful: Failed to create space', err);
            throw ResponseErrors.ErrorWithDebug('ContentfulFailedToCreateSpace', err);
        });
    },
    contextForBuild: (project, user, buildLogger) => {
        const cmdArgs = [];
        const contentfulSpaceId = _.get(project, 'deploymentData.contentful.spaceId');
        const contentfulConnection = user.connections.find(con => con.type === 'contentful');
        if (!contentfulConnection || !contentfulSpaceId) {
            buildLogger.error('Stackbit Factory: Missing contentful connection or space');
            throw {
                message: 'Stackbit Factory: Missing contentful connection or space'
            };
        }

        const contentfulAccessToken = contentfulConnection.accessToken;
        cmdArgs.push('--contentful-access-token=' + contentfulAccessToken);
        cmdArgs.push('--contentful-space-id=' + contentfulSpaceId);
        return cmdArgs;
    },
    envForDeployment: (project) => {
        const contentfulSpaceId = _.get(project, 'deploymentData.contentful.spaceId');
        const contentfulDeliveryToken = _.get(project, 'deploymentData.contentful.deliveryApiKey') || _.get(project, 'deploymentData.contentful.deployKey');
        // Both ACCESS_TOKEN and DELIVERY_TOKEN are required here because gatsby requires ACCESS_TOKEN to be set, and NextJS requires DELIVERY_TOKEN to be set. They both must contain the delivery token for deployment builds.
        return {
            CONTENTFUL_ACCESS_TOKEN: contentfulDeliveryToken,
            CONTENTFUL_DELIVERY_TOKEN: contentfulDeliveryToken,
            CONTENTFUL_SPACE_ID: contentfulSpaceId
        };
    },
    customImport: async (project, user, inputDir, buildLogger) => {
        buildLogger.debug('[contentful] run custom import');
        const importObject = project.wizard.theme.settings.themeConfig.import;
        const contentfulSpaceId = _.get(project, 'deploymentData.contentful.spaceId');
        const contentfulConnection = user.connections.find(con => con.type === 'contentful');
        if (!contentfulConnection || !contentfulSpaceId) {
            buildLogger.error('CMS Import Error: Missing contentful connection or space');
            throw new Error('CMS Import Error: Missing contentful connection or space');
        }
        const contentfulAccessToken = contentfulConnection.accessToken;
        const contentFile = _.get(importObject, 'contentFile');
        const uploadAssets = _.get(importObject, 'uploadAssets');
        const assetsDirectory = _.get(importObject, 'assetsDirectory');
        const command = path.join(__dirname, '../../../../node_modules/.bin/contentful-import');
        const cmdArgs = [
            '--space-id',
            contentfulSpaceId,
            '--management-token',
            contentfulAccessToken,
            '--content-file',
            contentFile,
            '--use-verbose-renderer',
            ...(uploadAssets ? [
                '--upload-assets',
                '--assets-directory',
                assetsDirectory
            ] : [])
        ];
        buildLogger.debug('[contentful] importing a space', { command, cmdArgs, inputDir });
        try {
            await getProcessPromise(spawn(command, cmdArgs, { cwd: inputDir }));
            buildLogger.debug('[contentful] successfully import a space');
        } catch (error) {
            buildLogger.error('[contentful] failed to import a space', { error });
            throw new Error('Failed importing contentful space, error: ' + error);
        }
    },
    customImportEnvVars: (project) => {
        const importObject = _.get(project, 'wizard.theme.settings.themeConfig.import');
        const spaceIdEnvVar = _.get(importObject, 'spaceIdEnvVar', 'CONTENTFUL_SPACE_ID');
        const accessTokenEnvVar = _.get(importObject, 'accessTokenEnvVar', 'CONTENTFUL_ACCESS_TOKEN');
        const contentfulSpaceId = _.get(project, 'deploymentData.contentful.spaceId');
        const deliveryApiKey = _.get(project, 'deploymentData.contentful.deliveryApiKey') || _.get(project, 'deploymentData.contentful.deployKey');
        return {
            [spaceIdEnvVar]: contentfulSpaceId,
            [accessTokenEnvVar]: deliveryApiKey
        };
    },
    connect: function (project, user, buildLogger) {
        const contentfulConnection = _.find(user.connections, {type: 'contentful'});
        if (!contentfulConnection) {
            buildLogger.error('Contentful: Access token missing for space creation');
            throw ResponseErrors.ContentfulNotConnected;
        }

        buildLogger.debug('Contentful: creating webhook for Stackbit');
        return contentfulApiService.createStackbitWebhook(project, contentfulConnection.accessToken).then(() => {
            return module.exports.updateContentVersion(project);
        }).then(project => {
            return Project.updateDeploymentData(project._id, 'contentful', {connected: true});
        }).catch(err => {
            buildLogger.error('Contentful: Failed to create Stackbit build hooks');
            throw ResponseErrors.ErrorWithDebug('ContentfulFailedToCreateStackbitBuildHook', err);
        });
    },
    onWebhook: async (project, user, req) => {
        const topic = req.headers['x-contentful-topic'] || '';
        const webhookName = req.headers['x-contentful-webhook-name'];
        const didContentTypeChange = topic.startsWith('ContentManagement.ContentType.');
        const didPublish = topic === 'ContentManagement.Entry.publish';
        const didArchive = topic === 'ContentManagement.Entry.archive';
        const didDelete = topic === 'ContentManagement.Entry.delete';
        const environment = _.get(req.body, 'sys.environment.sys.id');
        const environmentName = getEnvironmentNameFromContentfulEnvironment(project, environment);

        logger.debug('[cmss-contentful] received a webhook', {projectId: project.id, webhookName, topic, didContentTypeChange, didPublish, environment, environmentName});

        analytics.track('Contentful: Webhook Details', {
            projectId: project.id,
            userId: user.id,
            didPublish,
            topic,
            environmentName
        }, user);

        if (didContentTypeChange) {
            return require('../deployments').callDeploymentMethodForProject('refreshSchema', project, user, {
                branch: environmentName
            }).then(() => project);
        }

        if (didDelete || didArchive) {
            try {
                // usually container handles status if ssgRestartNeeded
                // no need to wait for container to handle this case if API already knows that page was deleted and
                // and projects based on nextjs and gatsby has to be restarted because of caching issues
                if (['nextjs', 'gatsby'].includes(project.wizard.ssg.id)) {
                    project = await Project.updateDeploymentData(project.id, 'container', {
                        ssgRestartNeeded: true
                    }, environmentName);
                }
                project = await Project.updateDeploymentData(project.id, 'contentful', {
                    versionOverride: uuid()
                }, environmentName);
            } catch (err) {
                logger.error('[cmss-contentful] could not update project versionOverride', { projectId: project.id, userId: user.id, error: err });
            }
        }

        return module.exports.updateContentVersion(project, environmentName)
            .then(project => {
                return Project.updateDeploymentData(project.id, 'contentful', {
                    publishedAt: new Date()
                }, environmentName);
            })
            .then(project => {
                if (didPublish) {
                    return require('../deployments').callDeploymentMethodForProject('triggerAutoBuild', project, user, {
                        buildType: 'content-only',
                        branch: environmentName
                    });
                }
                return project;
            }).catch(err => {
                logger.error('[cmss-contentful] failed to trigger deployment build', {projectId: project.id, userId: user.id, error: err, didPublish, didContentTypeChange});
            });
    },
    updateContentVersion(project, environmentName) {
        return Promise.resolve().then(() => {
            const spaces = contentfulProjectService.getProjectSpaces(project);

            let promises = spaces.map(space => {
                const spaceId = space.spaceId;
                const environment = project.getDeploymentData('contentful.environment', environmentName, _.get(space, 'environment', 'master'));
                const previewApiKey = space.previewApiKey;
                const currentSyncToken = project.getDeploymentData('contentful.nextSyncToken', environmentName, space.nextSyncToken);
                return contentfulPreviewApi.syncSpace(spaceId, environment, previewApiKey, currentSyncToken).then(response => {
                    return Project.updateSpaceById(project.id, spaceId, environmentName, { nextSyncToken: response.nextSyncToken }).then(() => response.nextSyncToken);
                });
            });

            return Promise.all(promises).then(results => results.join('+'));
        }).then(contentString => {
            const versionOverride = project.getDeploymentData('contentful.versionOverride', environmentName, '');
            return crypto.createHash('md5').update(`${contentString}+${versionOverride}`).digest('hex');
        }).then(contentVersion => {
            if (contentVersion && contentVersion !== project.getDeploymentData('contentful.contentVersion', environmentName)) {
                return Project.updateDeploymentData(project.id, 'contentful', {
                    contentVersion
                }, environmentName);
            }
            return project;
        }).catch(err=>{
            logger.error('[cmss-contentful] failed to get content version', {error: err.message, projectId: project.id, userId: project.ownerId});
            throw err;
        });
    },
    publishDrafts(project, user, { objects, type }, environmentName, buildLogger) {
        buildLogger.debug('[cmss-contentful] publishDrafts', {projectId: project.id});

        // by default, "type: all" coupled with empty "objects" array
        // there might be the case that even for "type: all" other method preprocessed objects and provided only needed object to publish
        // ====>
        // this logic has to be here not in parent method like publish-content-service.js => publishContent
        // publishContent too generic to cast "type" hence it has to be done in each CMS service separately
        const overridenType = objects.length ? 'objects' : 'all';

        const environment = project.getDeploymentData('contentful.environment', environmentName, _.get(objects, '[0].srcEnvironment'));
        return contentfulApiService.publishDrafts(project, user, { objects, type: overridenType, environment }).then(()=>{
            return Project.findProjectByIdAndUser(project.id, user, CollaboratorRole.Permission.PUBLISH_SITE);
        }).then(project => {
            return module.exports.updateContentVersion(project, environmentName);
        }).then(async result => {
            if (project.hasPreviewBranch() && type === 'all' && !project?.wizard?.theme?.settings?.multisite) {
                const hasChangesResult = await gitbased.hasChanges(project, user, { objects, type }, environmentName);
                buildLogger.debug('[cmss-contentful] checked gitbased for changes', {projectId: project.id, hasChangesResult});
                if (hasChangesResult?.hasChanges) {
                    buildLogger.debug('[cmss-contentful] publishing gitbased', {projectId: project.id});
                    return gitbased.publishDrafts(project, user, { objects, type }, environmentName, buildLogger).then(() => result);
                }
            }
            return result;
        }).catch(err => {
            logger.error('[cmss-contentful] publishDrafts failed', {error: err, projectId: project.id});
            throw err;
        });
    },
    hasAccess(project, user) {
        return contentfulApiService.hasAccess(project, user);
    },
    hasChanges(project, user, { objects, type }, environmentName) {
        const environment = project.getDeploymentData('contentful.environment', environmentName, _.get(objects, '[0].srcEnvironment'));
        return contentfulApiService.hasChanges(project, user, { objects, type, environment }).then(result => {
            if (project.hasPreviewBranch() && type === 'all' && !(result?.hasChanges)) {
                return gitbased.hasChanges(project, user, { objects, type }, environmentName);
            }
            return result;
        });
    },
    createPage(project, user, data) {
        return contentfulApiService.createPage(project, user, data);
    },
    duplicatePage(project, user, data) {
        return contentfulApiService.duplicatePage(project, user, data);
    },
    updatePage(project, user, data) {
        return contentfulApiService.updatePage(project, user, data);
    },
    async deleteObject(project, user, data) {
        const apiResponse = await contentfulApiService.deleteObject(project, user, data);

        try {
            const environmentName = getEnvironmentNameFromContentfulEnvironment(project, data.srcEnvironment);

            await containerService.deleteObject(project, user, {
                projectId: data.srcProjectId,
                objectId: data.srcObjectId
            }, environmentName);
        } catch (error) {
            logger.error('[cmss-contentful] deleteObject container call failed', {error});
        }

        return apiResponse;
    },
    envForContainer(project, user, environmentName) {
        //TODO multiple spaceId support
        const contentfulSpaceId = project.getDeploymentData('contentful.spaceId', environmentName);
        const contentfulAccessToken = project.getDeploymentData('contentful.manageKey', environmentName);
        const previewToken = project.getDeploymentData('contentful.previewApiKey',  environmentName);
        const environment = project.getDeploymentData('contentful.environment',  environmentName, 'master');
        return {
            CMS_TYPE: _.get(project, 'wizard.cms.id'),
            CONTENTFUL: {
                personalAccessToken: contentfulAccessToken,
                spaces: [{
                    spaceId: contentfulSpaceId,
                    previewToken: previewToken,
                    environment
                }]
            }
        };
    },
    async preProvision(project, user) {
        const projectDir = _.get(project, 'deploymentData.build.outputDir');
        const patch = {
            '__CONTENTFUL_SPACE_ID__': _.get(project, 'deploymentData.contentful.spaceId')
        };
        const hasRepo = await fse.exists(path.join(projectDir, '.git'));
        const simpleRepo = hasRepo ? gitP(projectDir) : null;
        return Promise.all([
            path.join(projectDir, 'README.md'),
            path.join(projectDir, 'sourcebit.js'),
            path.join(projectDir, 'stackbit-build.sh')
        ].map(filePath => {
            return fileUtils.patchFile(filePath, patch).then(didPatch => {
                if (didPatch && simpleRepo) {
                    return simpleRepo.add(filePath);
                }
            });
        })).then(() => project);
    },
    provision(project, user, draftsReadyCallback, progressCallback) {
        const provisioningFile = _.get(project, 'wizard.theme.settings.provisioningFile', 'export.json');
        const repoDir = _.get(project, 'deploymentData.build.outputDir');
        const contentfulSpaceId = _.get(project, 'deploymentData.contentful.spaceId');
        const contentfulConnection = user.connections.find(con => con.type === 'contentful');
        const provisioningFileFullPath = path.join(repoDir, provisioningFile);

        logger.debug('[cmss-contentful] provisioning', {provisioningFile});
        let promises = [];

        return fse.pathExists(provisioningFileFullPath).then(exists => {
            if (!exists) {
                logger.warn('[cmss-contentful] no provisioning file found', {provisioningFile, repoDir});
                return;
            }
            return fse.readFile(provisioningFileFullPath).then(data => {
                const context = JSON.parse(data);
                context.contentfulAccessToken = _.get(contentfulConnection, 'accessToken');
                context.contentfulSpaceId = contentfulSpaceId;
                context.projectDir = path.dirname(provisioningFileFullPath);
                context.delayPublish = true;
                if (progressCallback) {
                    context.onProgress = (progress) => {
                        promises.push(progressCallback(progress));
                    };
                }
                return factoryService.provision(repoDir, context);
            }).then(publishPromises => {
                logger.debug(`[cmss-contentful] running ${(publishPromises || []).length} delayed publishes`);
                return Project.updateDeploymentData(project.id, 'sanity', {
                    provisioned: true
                }).then(project => {
                    if (draftsReadyCallback) {
                        promises.push(draftsReadyCallback(project));
                    }
                    return Promise.all(promises.concat((publishPromises || []).map(delayedPromise => delayedPromise())));
                });
            });
        });
    },
    getAssets(project, user, data) {
        return contentfulApiService.getAssets(project, user, data);
    },
    uploadAssets(project, user, data) {
        return contentfulApiService.uploadAssets(project, user, data)
            .catch(err => {
                logger.debug('[cmss-contentful] failed to uploadAssets', {error: err.message, projectId: project.id, userId: user.id});
                throw err;
            });
    },
    provisionEnvironments(project, user, environments) {
        logger.debug('[cmss-contentful] provisionEnvironments', {projectId: project.id, environments});
        return Promise.all(
            environments.map(environmentName => {
                return contentfulApiService.createEnvironment(project, user, environmentName).then(() => {
                    return Project.updateDeploymentData(project.id, 'contentful', {
                        environment: environmentName
                    }, environmentName);
                });
            })
        ).then(() => {
            logger.debug('[cmss-contentful] updating api key', {projectId: project.id});
            const contentfulApiKeyId = project.getDeploymentData('contentful.apiKeyId');
            const deliveryApiKey = project.getDeploymentData('contentful.deliveryApiKey');
            return contentfulApiService.applyApiKeyToAllEnvironments(project, user, contentfulApiKeyId, deliveryApiKey);
        }).then(() => {
            logger.debug('[cmss-contentful] updating webhook', {projectId: project.id});
            return contentfulApiService.applyStackbitWebhookToAllEnvironments(project, user);
        }).then(() => {
            if (project.hasPreviewBranch()) {
                return gitbased.provisionEnvironments(project, user, environments);
            }
        }).then(() => Project.findProjectById(project.id));
    },
    migrateToEnvironment(project, user, environmentName, tag) {
        logger.debug('[cmss-contentful] migrateToEnvironment', {projectId: project.id, environmentName});
        return contentfulApiService.getEnvironmentAlias(project, user).then(alias => {
            if (alias) {
                return alias;
            }
            const contentfulEnvironmentName = `env-${crypto.randomBytes(4).toString('hex').substr(0,5)}`;
            return contentfulApiService.createEnvironmentAlias(project, user, contentfulEnvironmentName);
        }).then(alias => {
            const contentfulEnvironment = project.getDeploymentData('contentful.environment', environmentName);
            return contentfulApiService.updateEnvironmentAlias(project, user, contentfulEnvironment).then(() => project).then(() => {
                return contentfulApiService.removeEnvironment(project, user, alias.environment);
            });
        }).then(() => {
            if (project.hasPreviewBranch()) {
                return gitbased.migrateToEnvironment(project, user, environmentName, tag);
            }
        }).then(() => project);
    },
    removeEnvironments(project, user, environments) {
        logger.debug('[cmss-contentful] removeEnvironments', {projectId: project.id, environments});
        return contentfulApiService.getEnvironmentAlias(project, user).then(alias => {
            return Promise.all(
                environments.map(environmentName => {
                    const contentfulEnvironment = project.getDeploymentData('contentful.environment', environmentName);
                    if (contentfulEnvironment === 'master' ||
                        (alias && contentfulEnvironment === alias.environment)) {
                        return Promise.resolve();
                    }
                    return contentfulApiService.removeEnvironment(project, user, contentfulEnvironment);
                })
            );
        }).then(() => {
            if (project.hasPreviewBranch()) {
                gitbased.removeEnvironments(project, user, environments);
            }
        }).then(() => project);
    },
    pull(project, user, branch) {
        return gitbased.pull(project, user, branch);
    },
    importExisting(project, user, previewBranch, publishBranch, buildLogger) {
        if (_.get(project, 'deploymentData.contentful.connected')) {
            return Promise.resolve(project);
        }
        const space = project.getDeploymentData('contentful.space');
        const contentfulConnection = _.find(user.connections, {type: 'contentful'});
        if (!space || !contentfulConnection) {
            throw ResponseErrors.ContentfulNotConnected;
        }
        return contentfulApiService.createPersonalAccessToken(project, space, contentfulConnection.accessToken).then(manageKey => {
            let randomHash = Math.random().toString(36).substring(7);
            return contentfulApiService.createApiKeys(project, space, contentfulConnection.accessToken, `${randomHash}-${project.name}`).then(apiKeys => {
                return contentfulProjectService.addSpaceToProject(project, space, apiKeys, manageKey, false);
            });
        }).then(() => {
            return Project.updateDeploymentData(project._id, 'contentful', {
                connected: true,
                provisioned: true,
                branch: previewBranch
            });
        });
    }
};

function getEnvironmentNameFromContentfulEnvironment(project, srcEnvironment) {
    return _.first(Object.keys(_.get(project, 'environments', {})).map(environmentId => {
        if (_.get(project, `environments.${environmentId}.${_.get(project, 'wizard.cms.id')}.environment`) === srcEnvironment) {
            return environmentId;
        }
        return null;
    }).filter(Boolean));
}
