const { convertToYamlConfig } = require('@stackbit/sdk');
const yaml = require('js-yaml');
const config = require('../../config').default;
const importerService = require('../deploy-services/importer-service');
const Project = require('../../models/project.model').default;
const CollaboratorRole = require('../../models/collaborator-role.model').default;
const BuildError = require('../../models/build-error.model');
const rimraf = require('rimraf');
const _ = require('lodash');

const { BuildLogger } = require('../build-logger');
const analytics = require('../analytics/analytics');
const {sendSlackProjectMessage} = require('../analytics/slack-notifier');
const ResponseErrors = require('../../routers/response-errors');
const { ResponseError } = require('../utils/error.utils');

const deploymentTypes = require('./deployments');
const repositoryTypes = require('./repositories');
const cmsTypes = require('./cmss');

const netlifyDeployment = require('./deployments/netlify-deployment');

module.exports = {
    deployProject,
    deployPreview,
    deployWebflow
};

function getPreviewBranchName(user, project, buildLogger) {
    if (project?.wizard?.theme?.settings?.multiSite) {
        return repositoryTypes.callRepositoryMethodForProject('getDefaultBranch', project, user, buildLogger);
    }
    return 'preview';
}

function deployProject(projectId, user) {
    return new Promise((resolve, reject) => {
        let importCleanupProject;
        let buildCleanupProject;
        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.FULL_ACCESS).then(initialProject => {
            if (!initialProject) {
                reject(ResponseErrors.NotFound);
                throw ResponseErrors.NotFound;
            }

            if (initialProject.buildStatus !== 'draft') {
                reject(ResponseErrors.ProjectHasAlreadyBeenBuilt);
                throw ResponseErrors.ProjectHasAlreadyBeenBuilt;
            }

            const event = {
                projectId: _.get(initialProject, 'id'),
                userId: _.get(user, 'id'),
                theme: _.get(initialProject, 'wizard.theme.id'),
                ssg: _.get(initialProject, 'wizard.ssg.id'),
                cms: _.get(initialProject, 'wizard.cms.id'),
                deploymentType: _.get(initialProject, 'wizard.deployment.id', null),
                containerType: _.get(initialProject, 'wizard.container.id'),
                subscription: {
                    tierId: _.get(initialProject, 'subscription.tierId')
                },
                // Remove below analytics in the future.
                project: {
                    subscription: {
                        tierId: _.get(initialProject, 'subscription.tierId')
                    }
                }
            };
            if (_.get(initialProject, 'wizard.theme.id') === 'custom') {
                _.set(event, 'wizard.theme.settings.stackbitYmlFound', _.get(initialProject, 'wizard.theme.settings.stackbitYmlFound'));
                _.set(event, 'wizard.theme.settings.stackbitYmlValid', _.get(initialProject, 'wizard.theme.settings.stackbitYmlValid'));
            }
            analytics.track('Project Deploy Triggered', event, user, { project: initialProject });

            const buildLogger = BuildLogger(initialProject.id, user.id, {profiling: true});
            const deploymentTypeId = _.get(initialProject, 'wizard.deployment.id');
            const earlyResolve = !['container'].includes(deploymentTypeId);

            return Project.updateBuildStatus(initialProject.id, 'building', {buildStartTime: new Date().getTime()}).then(async project => {
                if (earlyResolve) {
                    resolve(project);   // return request
                }
                buildLogger.mark('preBuild');
                const previewBranchName = await getPreviewBranchName(user, project);
                return cmsTypes.baseInvokeContentSourcesWithProject('preBuild', project, user, previewBranchName, buildLogger);
            }).then(project => {
                return deploymentTypes.callDeploymentMethodForProject('createAPIKey', project, user, buildLogger);
            }).then(project => {
                buildLogger.mark('import');
                return importerService.doImport(project, user, buildLogger);
            }).then(project => {
                buildLogger.mark('build');
                importCleanupProject = project;
                return deploymentTypes.callDeploymentMethodForProject('buildProject', project, user, buildLogger);
            }).then(project => {
                buildLogger.mark('deploy');
                buildCleanupProject = project;
                return repositoryTypes.callRepositoryMethodForProject('deploy', project, user, buildLogger);
            }).then(project => {
                buildLogger.mark('preDeploy CMS');
                return cmsTypes.baseInvokeContentSourcesWithProject('preDeploy', project, user, buildLogger);
            }).then(project => {
                buildLogger.mark('preDeploy Deployment');
                return deploymentTypes.callDeploymentMethodForProject('preDeploy', project, user, buildLogger);
            }).then(project => {
                return deploymentTypes.callDeploymentMethodForProject('deploy', project, user, buildLogger);
            }).catch(err => {
                if (!earlyResolve) {
                    reject(err);
                }
                throw err;
            }).then(project => {
                buildLogger.mark('post-deploy');
                if (!earlyResolve) {
                    resolve(project);
                }
                return deploymentTypes.callDeploymentMethodForProject('postDeploy', project, user, buildLogger);
            }).then(project => {
                buildLogger.mark('connect');
                return cmsTypes.baseInvokeContentSourcesWithProject('connect', project, user, buildLogger);
            }).then(project => {
                const transferEnabled = _.get(project, 'settings.autoTransferRepoEnabled');
                if (transferEnabled) {
                    buildLogger.mark('transfer');
                    return repositoryTypes.callRepositoryMethodForProject('transferRepo', project, user, buildLogger);
                }
                return Promise.resolve(project);
            }).then(project => {
                buildLogger.mark('buildDone', {
                    theme: project?.wizard?.theme?.id,
                    ssg: project?.wizard?.ssg?.id,
                    cms: project?.wizard?.cms?.id,
                    importDataType: project?.importData?.dataType
                });

                const event = {
                    projectId: project?.id,
                    userId: user?.id,
                    theme: project?.wizard?.theme?.id,
                    ssg: project?.wizard?.ssg?.id,
                    cms: project?.wizard?.cms?.id,
                    deploymentType: project?.wizard?.deployment?.id ?? null,
                    containerType: project?.wizard?.container?.id,
                    subscription: {
                        tierId: project?.subscription?.tierId
                    },
                    isMultisite: project?.wizard?.theme?.settings?.multiSite,
                    name: project?.name,
                    siteUrl: project.siteUrl,
                    // Remove below analytics in the future.
                    project: {
                        name: project?.name,
                        siteUrl: project.siteUrl,
                        subscription: {
                            tierId: project?.subscription?.tierId
                        }
                    }
                };
                if (project?.wizard?.theme?.id === 'custom') {
                    _.set(event, 'wizard.theme.settings.stackbitYmlFound', project?.wizard?.theme?.settings?.stackbitYmlFound);
                    _.set(event, 'wizard.theme.settings.stackbitYmlValid', project?.wizard?.theme?.settings?.stackbitYmlValid);
                    sendSlackProjectMessage(config.slack.leadsCustomTheme, 'Project Deploy Success', project, user);
                }
                analytics.track('Project Deploy Success', event, user);

                const buildTimeStart = project?.metrics?.buildStartTime;
                if (buildTimeStart) {
                    const buildDuration = (new Date().getTime() - buildTimeStart) / 1000;
                    return Project.updateMetrics(projectId, {buildDuration});
                }

                return project;
            }).catch(err => {
                analytics.track('Project Deploy Failed', {
                    projectId: projectId,
                    userId: user.id,
                    error: err.message
                }, user);
                // TODO: add system here to filter whitelisted errors
                return Project.updateBuildStatus(projectId, 'build-failed', {message: err.message}).then(project => {
                    return BuildError.saveError(err, projectId, user.id).then(() => {
                        buildLogger.error('deployProject error', {
                            error: err,
                            stack: err.stack
                        });
                        if (_.get(project, 'wizard.theme.id') === 'custom') {
                            sendSlackProjectMessage(config.slack.leadsCustomTheme, 'Project Deploy Failed', project, user, err.message);
                        }
                        return project;
                    });
                });
            });
        }).finally(() => {
            let rmdir = _.get(buildCleanupProject, 'deploymentData.build.rmdir');
            if (rmdir) {
                rimraf(rmdir, (err) => {
                });
            }

            importerService.cleanup(importCleanupProject);
        });
    });
}

async function deployPreview({ projectId, user, projectParameters, previewBranch, publishBranch }) {
    const buildLogger = BuildLogger(projectId, user.id, { profiling: true });

    buildLogger.debug('[deploy-preview] starting');
    let project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.FULL_ACCESS);

    if (!project) {
        throw new ResponseError('NotFound');
    }

    if (projectParameters?.cmsData) {
        buildLogger.debug('[deploy-preview] update cms params', { cmsData: projectParameters?.cmsData });
        const cmsId = project.wizard?.cms?.id;
        project = await Project.updateDeploymentData(project.id, cmsId, projectParameters?.cmsData);
    }

    if (projectParameters?.ssgData) {
        buildLogger.debug('[deploy-preview] update ssg params', { ssgData: projectParameters?.ssgData });
        project = await Project.updateDeploymentData(project.id, 'container', projectParameters?.ssgData);
    }

    buildLogger.debug('[deploy-preview] import repo');
    project = await repositoryTypes.callRepositoryMethodForProject(
        'importExisting',
        project,
        user,
        previewBranch,
        publishBranch,
        buildLogger
    );

    if (projectParameters?.config) {
        buildLogger.debug('[deploy-preview] generate config');

        const ymlExistsInRepoBranch = await repositoryTypes.callRepositoryMethodForProject('contentExists',
            project,
            user,
            'stackbit.yaml',
            previewBranch,
            buildLogger
        );

        if (ymlExistsInRepoBranch.exists) {
            buildLogger.debug('[deploy-preview] yaml file already exists');
        }

        const yamlConfig = convertToYamlConfig({ config: projectParameters?.config });
        await repositoryTypes.callRepositoryMethodForProject('putFile',
            project,
            user,
            yaml.dump(yamlConfig),
            'stackbit.yaml',
            ymlExistsInRepoBranch.exists ? 'Update stackbit.yaml' : 'Autogenerate stackbit.yaml',
            previewBranch,
            ymlExistsInRepoBranch.sha,
            buildLogger
        );
    }

    buildLogger.debug('[deploy-preview] import cms');
    project = await cmsTypes.baseInvokeContentSourcesWithProject(
        'importExisting',
        project,
        user,
        previewBranch,
        publishBranch,
        buildLogger
    );

    if (projectParameters.envVars) {
        buildLogger.debug('[deploy-preview] update env vars');
        project = await Project.updateUserEnvironment(projectId, projectParameters.envVars);
    }

    buildLogger.debug('[deploy-preview] pre deploy');
    project = await deploymentTypes.callDeploymentMethodForProject('preDeploy', project, user, buildLogger, { publishBranch });

    if (_.get(project, 'deploymentData.container.url')) {
        buildLogger.debug('[deploy-preview] redeploying');

        try {
            project = await deploymentTypes.callDeploymentMethodForProject('destroy', project, user, buildLogger);
        } catch (err) {
            buildLogger.warn('Error deleting container before redeploy', { err });
        }

        project = await deploymentTypes.callDeploymentMethodForProject('redeploy', project, user, null, buildLogger, { force: true });
    } else {
        buildLogger.debug('[deploy-preview] deploying');
        project = await deploymentTypes.callDeploymentMethodForProject('createAPIKey', project, user);

        buildLogger.debug('deploying...');
        project = await deploymentTypes.callDeploymentMethodForProject('deploy', project, user, buildLogger);
    }

    return project;
}

async function deployWebflow({ projectId, user, projectParameters, previewBranch, publishBranch }) {
    const buildLogger = BuildLogger(projectId, user.id, {profiling: true});
    let project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.FULL_ACCESS);

    if (!project) {
        throw ResponseErrors.NotFound;
    }

    if (_.get(project, 'wizard.ssg.id') !== 'eleventy') {
        throw new Error('Wrong ssg');
    }

    project = await Project.updateProject(projectId, {
        'wizard.ssg.settings.isGeneric': false,
        'wizard.cms': {
            id: 'netlifycms',
            title: 'NetlifyCMS'
        }
    }, user.id);

    project = await deployPreview({ projectId, user, projectParameters, previewBranch, publishBranch });

    // deploy netlify site
    project = await Project.updateDeploymentData(projectId, _.get(project, 'wizard.cms.id'), {
        connected: true
    });

    return netlifyDeployment.deploy(project, user, buildLogger);
}
