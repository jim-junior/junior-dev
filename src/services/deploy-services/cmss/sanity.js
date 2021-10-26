const _ = require('lodash');
const path = require('path');
const fse = require('fs-extra');
const gitP = require('simple-git/promise');
const rimraf = require('rimraf');
const { promisify } = require('util');
const childProcess = require('child_process');

const Project = require('../../../models/project.model').default;
const ResponseErrors = require('../../../routers/response-errors');
const sanityService = require('../../sanity-services/sanity-service');
const logger = require('../../logger');
const fileUtils = require('../../utils/file-utils');
const { withRetry } = require('../../utils/code.utils');
const factoryService = require('../factory-service');
const gitbased = require('./gitbased');
const orchestrator = require('../container-orchestration-service');
const { getProcessPromise } = require('../../utils/process.utils');

module.exports = {
    preBuild: (project, user, previewBranchName, buildLogger) => {
        const sanityConnection = _.find(user.connections, {type: 'sanity'});
        if (!sanityConnection) {
            buildLogger.error('Sanity: Access token missing for project creation');
            throw ResponseErrors.SanityNotConnected;
        }
        buildLogger.debug('Sanity: creating project');
        return withRetry(() => sanityService.createProject(project, sanityConnection.accessToken, buildLogger), { logger: buildLogger }).then(sanityProject => {
            buildLogger.debug('Sanity: creating deploy keys');
            return Promise.all([
                sanityService.createDeployKey(project, sanityProject,'write', sanityConnection.accessToken, buildLogger),
                sanityService.createDeployKey(project, sanityProject,'deploy-studio', sanityConnection.accessToken, buildLogger)
            ]).then(([deployKey, studioKey]) => {
                return Project.updateDeploymentData(project._id, 'sanity', {
                    connected: false,
                    projectId: sanityProject.id,
                    projectName: sanityProject.displayName,
                    studioKey: studioKey.key,
                    deployKey: deployKey.key,
                    branch: previewBranchName
                });
            });
        }).catch(err => {
            sanityService.deleteProject(project, sanityConnection.accessToken).catch((delErr) => {
                buildLogger.error('Sanity: cannot delete project', {error: delErr});
            });

            buildLogger.error('Sanity: Failed to create project', {error: err});
            throw ResponseErrors.ErrorWithDebug('SanityFailedToCreateProject', err);
        });
    },
    contextForBuild: (project, user, buildLogger) => {
        const cmdArgs = [];
        const sanityProjectId = _.get(project, 'deploymentData.sanity.projectId');
        const sanityProjectName = _.get(project, 'deploymentData.sanity.projectName');
        const sanityConnection = user.connections.find(con => con.type === 'sanity');
        if (!sanityConnection || !sanityProjectId) {
            buildLogger.error('Stackbit Factory: Missing sanity connection or project');
            throw {
                message: 'Stackbit Factory: Missing sanity connection or project'
            };
        }

        const sanityAccessToken = sanityConnection.accessToken;

        cmdArgs.push('--sanity-access-token=' + sanityAccessToken);
        cmdArgs.push('--sanity-project-id=' + sanityProjectId);
        cmdArgs.push('--sanity-project-name=' + sanityProjectName);
        return cmdArgs;
    },
    envForDeployment: (project) => {
        const sanityAccessToken = _.get(project, 'deploymentData.sanity.deployKey');
        return {
            SANITY_ACCESS_TOKEN: sanityAccessToken
        };
    },
    customImport: async (project, user, inputDir, buildLogger) => {
        const importObject = _.get(project, 'wizard.theme.settings.themeConfig.import', {});
        const sanityProjectId = _.get(project, 'deploymentData.sanity.projectId');
        const dataset = _.get(project, 'deploymentData.sanity.dataset', 'production');
        const contentFile = _.get(importObject, 'contentFile');
        const sanityStudioPath = _.get(importObject, 'sanityStudioPath');

        const sanityConnection = user.getConnectionByType('sanity');
        if (!sanityConnection) {
            throw new Error('Sanity connection was not found');
        }
        const sanityAccessToken = sanityConnection.accessToken;

        const updateBuildProgress = async (step) => {
            step = step ? `/${step}` : '';
            await Project.updateDeploymentData(project.id, 'container', {
                buildProgress: `${orchestrator.BuildStates.provisioningCms}${step}`
            });
        };

        await updateBuildProgress('createDataset');
        buildLogger.debug('[sanity] creating a dataset');
        await sanityService.createDataset(sanityProjectId, sanityAccessToken, dataset);

        await updateBuildProgress('importDataset');
        buildLogger.debug('[sanity] importing a dataset');
        await sanityService.importDataset({
            project,
            user,
            exportFilePath: path.join(inputDir, contentFile),
            sanityProjectId: sanityProjectId,
            dataset: dataset,
            token: sanityAccessToken,
            useCdn: false,
            operation: 'create'
        });

        if (sanityStudioPath) {
            const studioPath = path.join(inputDir, sanityStudioPath);
            buildLogger.debug('[sanity] sanityStudioPath defined', { sanityStudioPath, studioPath });
            await updateBuildProgress('updateFiles');
            await updateSanityStudioFiles({ project, studioPath, buildLogger });
            await deploySanityStudioAndGraphqlIfNeeded({ project, studioPath, updateBuildProgress, buildLogger });
        }

        return project;
    },
    customImportEnvVars: (project) => {
        const importObject = _.get(project, 'wizard.theme.settings.themeConfig.import');
        const projectIdEnvVar = _.get(importObject, 'projectIdEnvVar', 'SANITY_PROJECT_ID');
        const datasetEnvVar = _.get(importObject, 'datasetEnvVar', 'SANITY_DATASET');
        const tokenEnvVar = _.get(importObject, 'tokenEnvVar', 'SANITY_TOKEN');
        const projectId = _.get(project, 'deploymentData.sanity.projectId');
        const dataset = _.get(project, 'deploymentData.sanity.dataset');
        const deployKey = _.get(project, 'deploymentData.sanity.deployKey');
        return {
            [projectIdEnvVar]: projectId,
            [datasetEnvVar]: dataset,
            [tokenEnvVar]: deployKey
        };
    },
    connect: (project, user, buildLogger) => {
        const sanityConnection = _.find(user.connections, {type: 'sanity'});
        if (!sanityConnection) {
            buildLogger.error('Sanity: Access token missing for project creation');
            throw ResponseErrors.SanityNotConnected;
        }

        buildLogger.debug('Sanity: creating webhook for Stackbit');
        return sanityService.createStackbitWebhook(project, sanityConnection.accessToken).then(() => {
            const sanityProjectName = _.get(project, 'deploymentData.sanity.projectName');
            return Project.updateDeploymentData(project._id, 'sanity', {
                connected: true,
                url: `https://${sanityProjectName}.sanity.studio`
            });
        }).catch(err => {
            buildLogger.error('Sanity: Failed to create stackbit build hooks');
            throw ResponseErrors.ErrorWithDebug('SanityFailedToCreateStackbitBuildHook', err);
        });
    },
    onWebhook: (project, user, req) => {
        const dataset = _.get(req, 'body.dataset');
        const environmentName = getEnvironmentNameFromDataset(project, dataset);
        logger.debug('[cmss-sanity] received a webhook', {dataset, environmentName});
        return Project.updateDeploymentData(project.id, 'sanity', {
            publishedAt: new Date()
        }, environmentName).then(project => {
            return require('../deployments').callDeploymentMethodForProject('triggerAutoBuild', project, user, {
                buildType: 'content-only',
                branch: environmentName
            });
        }).catch(err => {
            logger.error('Sanity Webhook: Failed to trigger deployment build', {projectId: project.id, userId: user.id, error: err});
        });
    },

    hasChanges(project, user, { objects, type }, environmentName) {
        const dataset = project.getDeploymentData('sanity.dataset', environmentName, _.get(objects, '[0].srcEnvironment'));
        return sanityService.hasChanges(project, user, { objects, type, dataset }).then(result => {
            if (project.hasPreviewBranch() && type === 'all' && !(result?.hasChanges)) {
                return gitbased.hasChanges(project, user, { objects, type }, environmentName);
            }
            return result;
        });
    },

    updatePage(project, user, data) {
        return sanityService.updatePage(project, user, data)
            .catch(err => {
                logger.debug('[cmss-sanity] failed to updatePage', {error: err.message, projectId: project.id, userId: user.id});
                throw err;
            });
    },

    hasAccess(project, user, data) {
        return sanityService.hasAccess(project, user, data);
    },

    publishDrafts(project, user, { objects, type }, environmentName, buildLogger) {
        return sanityService.publishDrafts(project, user, { objects, type }, environmentName).then(async result => {
            if (project.hasPreviewBranch() && type === 'all') {
                const hasChangesResult = await gitbased.hasChanges(project, user, { objects, type }, environmentName);
                buildLogger.debug('[cmss-sanity] checked gitbased for changes', {projectId: project.id, hasChangesResult});
                if (hasChangesResult?.hasChanges) {
                    buildLogger.debug('[cmss-sanity] publishing gitbased', {projectId: project.id});
                    return gitbased.publishDrafts(project, user, { objects, type }, environmentName, buildLogger).then(() => result);
                }
            }
            return result;
        }).catch(err => {
            logger.debug('[cmss-sanity] failed to publishDrafts', {error: err.message, projectId: project.id, userId: user.id});
            throw err;
        });
    },

    duplicatePage(project, user, data) {
        return sanityService.duplicatePage(project, user, data)
            .catch(err => {
                logger.debug('[cmss-sanity] failed to duplicatePage', {error: err.message, projectId: project.id, userId: user.id});
                throw err;
            });
    },

    createPage(project, user, data) {
        return sanityService.createPage(project, user, data)
            .catch(err => {
                logger.debug('[cmss-sanity] failed to createPage', {error: err.message, projectId: project.id, userId: user.id});
                throw err;
            });
    },

    deleteObject(project, user, data) {
        return sanityService.deleteObject(project, user, {...data, deleteDraft: true})
            .catch(err => {
                logger.debug('[cmss-sanity] failed to deleteObject', {error: err.message, projectId: project.id, userId: user.id, objectId: data.srcObjectId});
                throw err;
            });
    },

    envForContainer(project, user, environmentName) {
        const sanityConnection = _.find(user.connections, {type: 'sanity'});
        return {
            CMS_TYPE: _.get(project, 'wizard.cms.id'),
            SANITY: {
                projectId: project.getDeploymentData('sanity.projectId', environmentName),
                projectUrl: project.getDeploymentData('sanity.url'),
                dataset: project.getDeploymentData('sanity.dataset', environmentName, 'production'),
                studioPath: project.getDeploymentData('sanity.studioPath', environmentName, 'studio'),
                token: project.getDeploymentData('sanity.deployKey', environmentName, 'studio'),
            }
        };
    },

    async preProvision(project, user) {
        const projectName = _.get(project, 'deploymentData.sanity.projectName');
        const projectId = _.get(project, 'deploymentData.sanity.projectId');
        const studioPath = _.get(project, 'deploymentData.sanity.studioPath', 'studio');
        const projectDir = _.get(project, 'deploymentData.build.outputDir');
        const absStudioPath = path.join(projectDir, studioPath);

        const patch = {
            '__SANITY_PROJECT_NAME__': projectName,
            '__SANITY_PROJECT_ID__': projectId
        };

        const hasRepo = await fse.exists(path.join(projectDir, '.git'));
        const simpleRepo = hasRepo ? gitP(projectDir) : null;
        return Promise.all([
            path.join(projectDir, 'README.md'),
            path.join(projectDir, 'sourcebit.js'),
            path.join(projectDir, 'stackbit-build.sh'),
            path.join(absStudioPath, 'sanity.json'),
            path.join(absStudioPath, 'package.json'),
            path.join(absStudioPath, 'dist/static/js/app.bundle.js'),
            path.join(absStudioPath, 'dist/index.html')
        ].map(filePath => {
            return fileUtils.patchFile(filePath, patch).then(() => {
                if (simpleRepo) {
                    return simpleRepo.add(filePath);
                }
            });
        })).then(() => project);
    },

    provision(project, user, draftsReadyCallback, progressCallback) {
        const provisioningFile = _.get(project, 'wizard.theme.settings.provisioningFile', 'export.json');
        const repoDir = _.get(project, 'deploymentData.build.outputDir');
        const projectId = _.get(project, 'deploymentData.sanity.projectId');
        const projectName = _.get(project, 'deploymentData.sanity.projectName');
        const sanityConnection = user.connections.find(con => con.type === 'sanity');
        const provisioningFileFullPath = path.join(repoDir, provisioningFile);

        logger.debug('[cmss-sanity] provisioning', {provisioningFile});
        let promises = [];

        return fse.pathExists(provisioningFileFullPath).then(exists => {
            if (!exists) {
                logger.warn('[cmss-sanity] no provisioning file found', {provisioningFile, repoDir});
                return;
            }
            return fse.readFile(provisioningFileFullPath).then(data => {
                const context = JSON.parse(data);
                context.sanityAccessToken = _.get(sanityConnection, 'accessToken');
                context.sanityProjectId = projectId;
                context.sanityProjectName = projectName;
                context.projectDir = path.dirname(provisioningFileFullPath);
                context.delayPublish = true;
                if (progressCallback) {
                    context.onProgress = (progress) => {
                        promises.push(progressCallback(progress));
                    };
                }
                return factoryService.provision(repoDir, context);
            }).then(publishPromises => {
                logger.debug(`[cmss-sanity] running ${(publishPromises || []).length} delayed publishes`);
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
        return sanityService.getAssets(project, user, data)
            .catch(err => {
                logger.debug('[cmss-sanity] failed to getAssets', {error: err.message, projectId: project.id, userId: user.id});
                throw err;
            });
    },

    uploadAssets(project, user, data) {
        return sanityService.uploadAssets(project, user, data)
            .catch(err => {
                logger.debug('[cmss-sanity] failed to uploadAssets', {error: err.message, projectId: project.id, userId: user.id});
                throw err;
            });
    },

    provisionEnvironments(project, user, environments) {
        logger.debug('[cmss-sanity] provisionEnvironments', {projectId: project.id, environments});
        const projectId = _.get(project, 'deploymentData.sanity.projectId');
        const token = _.get(_.find(user.connections, { type: 'sanity' }), 'accessToken');
        const primaryDataset = _.get(project, 'deploymentData.sanity.dataset', 'production');
        return sanityService.createDatasetCopies(project, user, projectId, primaryDataset, environments).then(() => {
            return Promise.all(
                environments.map(environmentName => {
                    return sanityService.createStackbitWebhook(project, token, environmentName).then(() => {
                        return Project.updateDeploymentData(project.id, 'sanity', {
                            dataset: environmentName
                        }, environmentName);
                    });
                })
            );
        }).then(() => {
            if (project.hasPreviewBranch()) {
                return gitbased.provisionEnvironments(project, user, environments);
            }
        }).then(() => Project.findProjectById(project.id));
    },

    async migrateToEnvironment(project, user, environmentName, tag) {
        logger.debug('[cmss-sanity] migrateToEnvironment', {projectId: project.id, environmentName});
        const primaryDataset = _.get(project, 'deploymentData.sanity.dataset', 'production');
        const dataset = project.getDeploymentData('sanity.dataset', environmentName);
        if (dataset !== primaryDataset) {
            const projectId = _.get(project, 'deploymentData.sanity.projectId');
            project = await sanityService.migrateToDataset(project, user, projectId, dataset, primaryDataset).then(() => project);
        }
        if (project.hasPreviewBranch()) {
            project = await gitbased.migrateToEnvironment(project, user, environmentName, tag);
        }
        return project;
    },

    removeEnvironments(project, user, environments) {
        logger.debug('[cmss-sanity] removeEnvironments', {projectId: project.id, environments});
        const projectId = _.get(project, 'deploymentData.sanity.projectId');
        const token = _.get(_.find(user.connections, { type: 'sanity' }), 'accessToken');
        return Promise.all(environments.map(environmentName => {
            const dataset = project.getDeploymentData('sanity.dataset', environmentName);
            return sanityService.deleteStackbitWebbhook(project, token, dataset).then(() => {
                return sanityService.deleteDataset(projectId, token, dataset);
            });
        })).then(() => {
            if (project.hasPreviewBranch()) {
                return gitbased.removeEnvironments(project, user, environments);
            }
            return project;
        });
    },

    importExisting(project, user, previewBranch, publishBranch, buildLogger) {
        if (_.get(project, 'deploymentData.sanity.connected')) {
            return Promise.resolve(project);
        }
        const projectId = project.getDeploymentData('sanity.projectId');
        const dataset = project.getDeploymentData('sanity.dataset');
        const token = _.get(_.find(user.connections, { type: 'sanity' }), 'accessToken');
        if (!projectId || !dataset || !token) {
            throw ResponseErrors.SanityNotConnected;
        }
        return sanityService.createDeployKey(project, {id: projectId}, 'write', token, buildLogger).then(deployKey => {
            return Project.updateDeploymentData(project._id, 'sanity', {
                connected: true,
                provisioned: true,
                deployKey: deployKey.key,
                branch: previewBranch
            });
        }).catch(err => {
            logger.error('Error importing Sanity project', {err});
            throw ResponseErrors.SanityNotConnected;
        });
    },

    pull(project, user, branch) {
        return gitbased.pull(project, user, branch);
    }
};


function getEnvironmentNameFromDataset(project, srcEnvironment) {
    return _.first(Object.keys(_.get(project, 'environments', {})).map(environmentId => {
        if (_.get(project, `environments.${environmentId}.${_.get(project, 'wizard.cms.id')}.dataset`) === srcEnvironment) {
            return environmentId;
        }
        return null;
    }).filter(Boolean));
}

async function updateSanityStudioFiles({ project, studioPath, buildLogger }) {
    const sanityProjectId = _.get(project, 'deploymentData.sanity.projectId');
    const dataset = _.get(project, 'deploymentData.sanity.dataset', 'production');
    const projectName = _.get(project, 'name');

    const sanityJsonPath = path.join(studioPath, 'sanity.json');
    const sanityJsonExists = await fse.pathExists(sanityJsonPath);
    if (sanityJsonExists) {
        buildLogger.debug('[sanity] setting projectId and dataset in sanity.json');
        const sanityJson = await fse.readJson(sanityJsonPath);
        _.set(sanityJson, 'api.projectId', sanityProjectId);
        _.set(sanityJson, 'api.dataset', dataset);
        _.set(sanityJson, 'project.name', projectName);
        await fse.writeFile(sanityJsonPath, JSON.stringify(sanityJson, null, 2));
    }

    const packageJsonPath = path.join(studioPath, 'package.json');
    const packageJsonExists = await fse.pathExists(packageJsonPath);
    if (packageJsonExists) {
        buildLogger.debug('[sanity] setting project name in package.json');
        const packageJson = await fse.readJson(packageJsonPath);
        _.set(packageJson, 'name', projectName);
        await fse.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
    }

    const packageJsonLockPath = path.join(studioPath, 'package-lock.json');
    const packageJsonLockExists = await fse.pathExists(packageJsonLockPath);
    if (packageJsonLockExists) {
        buildLogger.debug('[sanity] setting project name in package-lock.json');
        const packageJson = await fse.readJson(packageJsonLockPath);
        _.set(packageJson, 'name', projectName);
        await fse.writeFile(packageJsonLockPath, JSON.stringify(packageJson, null, 2));
    }
}

async function deploySanityStudioAndGraphqlIfNeeded({ project, studioPath, updateBuildProgress, buildLogger }) {
    const importObject = _.get(project, 'wizard.theme.settings.themeConfig.import', {});
    const deployStudio = _.get(importObject, 'deployStudio');
    const deployGraphql = _.get(importObject, 'deployGraphql');

    if (deployGraphql || deployStudio) {
        await updateBuildProgress('installDependencies');
        await installSanityStudioDependencies({ studioPath, buildLogger });

        const sanityStudioKey = _.get(project, 'deploymentData.sanity.studioKey');

        if (deployStudio) {
            await updateBuildProgress('deployStudio');
            await deploySanityStudio({ studioPath, sanityStudioKey, buildLogger });
        }

        if (deployGraphql) {
            await updateBuildProgress('deployGraphql');
            await deploySanityGraphql({ studioPath, sanityStudioKey, buildLogger });
        }

        await removeSanityStudioNodeModules({ studioPath, buildLogger });
    }
}

async function installSanityStudioDependencies({ studioPath, buildLogger }) {
    try {
        const yarnLockPath = path.join(studioPath, 'yarn.lock');
        const yarnLockExists = await fse.pathExists(yarnLockPath);
        const command = yarnLockExists ? 'yarn' : 'npm';
        buildLogger.debug('[sanity] installing studio dependencies', { command });
        await getProcessPromise(childProcess.spawn(command, ['install'], { cwd: studioPath }));
        buildLogger.debug('[sanity] successfully installed dependencies');
    } catch (error) {
        buildLogger.error('[sanity] failed installing dependencies', { error });
        throw new Error('Failed installing sanity studio dependencies, error: ' + error);
    }
}

async function removeSanityStudioNodeModules({ studioPath, buildLogger }) {
    const nodeModulesPath = path.join(studioPath, 'node_modules');
    buildLogger.debug('[sanity] delete studio node_modules', {nodeModulesPath});
    try {
        await promisify(rimraf)(nodeModulesPath);
    } catch (error) {
        buildLogger.error('[sanity] failed to delete studio node_modules', { error });
    }
}

async function deploySanityStudio({ studioPath, sanityStudioKey, buildLogger }) {
    try {
        buildLogger.debug('[sanity] deploying sanity studio');
        await getProcessPromise(childProcess.spawn(
            'npx',
            ['@sanity/cli', 'deploy'],
            {
                cwd: studioPath,
                env: Object.assign(process.env, {
                    SANITY_AUTH_TOKEN: sanityStudioKey
                })
            }
        ));
        buildLogger.debug('[sanity] successfully deployed sanity studio');
    } catch (error) {
        buildLogger.error('[sanity] failed deploying sanity studio', { error });
        throw new Error('Failed deploying sanity studio, error: ' + error);
    }
}

async function deploySanityGraphql({ studioPath, sanityStudioKey, buildLogger }) {
    try {
        buildLogger.debug('[sanity] deploying graphql');
        await getProcessPromise(childProcess.spawn(
            'npx',
            ['@sanity/cli', 'graphql', 'deploy', '--playground', '--force'],
            {
                cwd: studioPath,
                env: Object.assign(process.env, {
                    SANITY_AUTH_TOKEN: sanityStudioKey
                })
            }
        ));
        buildLogger.debug('[sanity] successfully deployed graphql');
    } catch (error) {
        buildLogger.error('[sanity] failed deploying graphql', { error });
        throw new Error('Failed deploying graphql, error: ' + error);
    }
}
