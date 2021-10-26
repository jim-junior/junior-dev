const _ = require('lodash');
const uuid = require('uuid/v4');
import mongoose from 'mongoose';

const Project = require('../../models/project.model').default;
const CollaboratorRole = require('../../models/collaborator-role.model').default;
const User = require('../../models/user.model').default;
const stripeService = require('../../services/stripe-service/stripe-service');
const ProjectBuildService = require('../../services/deploy-services/project-build-service');
const ProjectService = require('../../services/project-services/project-service');
const googleService = require('../../services/google-services/google-service');
const netlifyService = require('../../services/netlify-services/netlify-service');
const publishContentService = require('../../services/deploy-services/publish-content-service');
const SplitTestService = require('../../services/deploy-services/split-test-service');
const mailgunService = require('../../services/mailgun-service/mailgun-service');
const workflowService = require('../../services/project-services/workflow-service');
const {
    sendPlansEmail,
    sendContactFormEmail,
    PLANS_EMAIL_EVENT
} = require('../../services/customerio-service/customerio-transactional-service');
const logger = require('../../services/logger');
const { BuildLogger } = require('../../services/build-logger');
const analytics = require('../../services/analytics/analytics');
const config = require('../../config').default;
const cmsTypes = require('../../services/deploy-services/cmss');
const repositoryTypes = require('../../services/deploy-services/repositories');
const deployments = require('../../services/deploy-services/deployments');
const { sendSlackProjectMessage } = require('../../services/analytics/slack-notifier');
const {
    getSiteUrl,
    renameSite,
    updateStackbitSchema,
    generateStackbitSchema,
    getSiteConfig,
    updateSiteConfig
} = require('../../services/deploy-services/container-service');
const { validateSiteName } = require('../../services/project-services/project-utils').default;
const { makeAction, actionPermission } = require('../../services/editor-services/editor-action-service');
const { analyze } = require('../../services/project-services/import-project.service');
const projectUtils = require('../../services/project-services/project-utils').default;
const ScoreService = require('../../services/project-services/score-service');
const customerTierService = require('../../services/customer-tier-service/customer-tier-service');
const errorUtils = require('../../services/utils/error.utils');
const ResponseErrors = require('../response-errors');
const GithubService = require('../../services/github-services/github-repo');
const MAX_NUM_PROJECT_UPDATE = 10;

function sanitizeProjectInput(project) {
    return _.pick(project, [
        'name',
        'wizard',
        'widget',
        'settings',
        'deploymentData.container.env',
        'deploymentData.container.runnableDir',
        'deploymentData.container.refreshCommand',
        'subscription.tierId',
        'importData.dataType'
    ]);
}

module.exports = {
    generateProjectId: async (req, res) => {
        try {
            let projectIdToken = await projectUtils.generateProjectIdToken();
            res.json({ projectIdToken });
        } catch (err) {
            res.status(err.status || 500).json(err);
        }
    },
    quickDeploy: async (req, res) => {
        const user = req.user;
        const initialProject = sanitizeProjectInput(req.body.project);
        const token = req.body.token;

        try {
            // Please supply the project ID inside the jwt `token`, not on the `project`
            if (initialProject.id) {
                throw new errorUtils.ResponseError('InvalidProjectId');
            }

            // todo move into service of single create project method
            initialProject.widget = {
                flatTree: true,
                realtimeEditor: false,
                reloadSchemaWithFields: false,
                hmrReload: false,
                slateRichTextEnabled: false,
                // legacy project support which doesn't support such things
                branchInfoEnabled: true,
                schemaEditorEnabled: true,
                codeEditorActionsEnabled: true,
                codeEditorEnabled: true
            };

            let project = await Project.createProject(initialProject, user, token);

            if (customerTierService.getTierAttributes(project.subscription.tierId)?.isTrial) {
                // The app wizard wanted to auto-start a trial for this project. We properly
                // start it to set all needed properties.
                project = await Project.startTrial(project, project.subscription.tierId, true);
                await sendPlansEmail(project, project.subscription.tierId, PLANS_EMAIL_EVENT.STARTED);
                analytics.track(
                    'Trial Started',
                    {
                        projectId: project.id,
                        userId: user.id,
                        userEmail: user.email,
                        tierId: project.subscription.tierId,
                        projectUrl: project.siteUrl
                    },
                    user
                );
            } else if (!customerTierService.isFreeTier(project.subscription.tierId)) {
                // This is an anti-abuse mechanism. Since the initial tier is set by the app, we don't want
                // to allow a malicious user to change app code to start them off with a paid tier.
                project = await Project.cancelSubscription(project.id, { immediate: true });
            }

            analytics.track(
                'API Project Created',
                {
                    userId: user.id,
                    projectId: project.id,
                    type: 'api-quick-deploy',
                    theme: _.get(project, 'wizard.theme.id'),
                    ssg: _.get(project, 'wizard.ssg.id'),
                    cms: _.get(project, 'wizard.cms.id'),
                    deploymentType: _.get(project, 'wizard.deployment.id', null),
                    containerType: _.get(project, 'wizard.container.id')
                },
                user
            );
            project = await ProjectBuildService.deployProject(project.id, user);
            res.json(await Project.projectObjectForResponse(project, user));
        } catch (err) {
            res.status(err.status || 500).json(err);
        }
    },
    importNetlifySite: (req, res, next) => {
        const deploymentId = 'netlify';
        const { site } = req.body;
        return Project.findProjectByNetlifySiteIdAndOwnerId(site.id, req.user.id)
            .then((project) => {
                if (project) {
                    logger.debug('Netlify Importer: Found existing project', { projectId: project.id });
                    // This user comes from Import Netlify Site landing page where he picks his netlify site from his account, therefore he must have netlifyAccessToken
                    return netlifyService
                        .upgradeStackbitSiteWithWidget(
                            project,
                            req.user,
                            req.user.netlifyAccessToken,
                            config.build.stackbitWidgetForImportedSites.enabled
                        )
                        .then(() => {
                            res.json(project);
                            analytics.track(
                                'Import Netlify Upgrade Site',
                                {
                                    projectId: project.id,
                                    userId: req.user.id
                                },
                                req.user
                            );
                        })
                        .catch((err) => {
                            logger.error(`Import Existing project error: ${err.name} ${err.message}`);
                        });
                } else {
                    logger.debug('Netlify Importer: Creating new project', { siteId: site.id });
                    return Project.createProject(
                        {
                            name: site.name,
                            wizard: {
                                theme: {
                                    id: 'none',
                                    title: 'None'
                                },
                                ssg: {
                                    id: 'none',
                                    title: 'None'
                                },
                                cms: {
                                    id: 'nocms',
                                    title: 'No CMS'
                                },
                                repository:
                                    _.get(site, 'build_settings.provider') === 'github'
                                        ? {
                                            id: 'github',
                                            title: 'Github'
                                        }
                                        : {
                                            id: 'none',
                                            title: 'None'
                                        },
                                deployment: {
                                    id: deploymentId,
                                    title: 'Netlify',
                                    settings: {
                                        netlifyId: site.id
                                    }
                                }
                            },
                            importData: {
                                dataType: deploymentId
                            },
                            settings: {
                                autoBuildTriggerEnabled: false
                            },
                            buildStatus: 'live',
                            status: 'live'
                        },
                        req.user
                    )
                        .then((project) => {
                            analytics.track(
                                'API Project Created',
                                {
                                    userId: req.user.id,
                                    projectId: project.id,
                                    type: 'netlify-import',
                                    theme: _.get(project, 'wizard.theme.id'),
                                    ssg: _.get(project, 'wizard.ssg.id'),
                                    cms: _.get(project, 'wizard.cms.id'),
                                    deploymentType: _.get(project, 'wizard.deployment.id', null),
                                    containerType: _.get(project, 'wizard.container.id'),
                                    // backward compatible analytics
                                    // remove in future
                                    deployment: _.get(project, 'wizard.container.id', _.get(project, 'wizard.deployment.id', null)),
                                    settings: _.get(project, 'wizard.settings')
                                },
                                req.user
                            );

                            const siteId = _.get(project, 'wizard.deployment.settings.netlifyId');
                            const buildLogger = BuildLogger(project.id, req.user.id);
                            return netlifyService
                                .importNetlifySite(
                                    project,
                                    siteId,
                                    req.user.netlifyAccessToken,
                                    config.build.stackbitWidgetForImportedSites.enabled,
                                    buildLogger
                                )
                                .then(({ netlifySite, buildHook }) => {
                                    return Project.updateDeploymentData(project.id, deploymentId, {
                                        id: netlifySite.id,
                                        url: netlifySite.admin_url.toLowerCase(),
                                        buildHookUrl: buildHook.url,
                                        connected: true
                                    })
                                        .then((project) => {
                                            if (
                                                _.get(netlifySite, 'build_settings.provider') === 'github' &&
                                                _.get(netlifySite, 'build_settings.repo_url')
                                            ) {
                                                return Project.updateDeploymentData(project.id, 'github', {
                                                    url: _.get(netlifySite, 'build_settings.repo_url')
                                                });
                                            }
                                            return project;
                                        })
                                        .then((project) => {
                                            return Project.updateProject(
                                                project.id,
                                                {
                                                    'widget.netlifyInject': true,
                                                    deployedAt: _.get(netlifySite, 'build_settings.updated_at')
                                                },
                                                req.user.id
                                            );
                                        })
                                        .then((project) => {
                                            return Project.updateSiteUrl(project.id, netlifySite.ssl_url.toLowerCase());
                                        });
                                })
                                .then((project) => {
                                    res.json(project);
                                    analytics.track('Import Netlify Import Site', { projectId: project.id, userId: req.user.id }, req.user);
                                });
                        })
                        .catch((err) => {
                            logger.error(`Import Netlify site error: ${err.name} ${err.message}`, { error: err });
                        });
                }
            })
            .catch(next);
    },
    getProject: async (req, res) => {
        const { id: projectId } = req.params;
        try {
            const { env, format } = req.query;
            const { user } = req;
            let project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS);
            if (!project) {
                throw ResponseErrors.NotFound;
            }
            project = await Project.downgradePlanIfNeeded(project);
            project = await deployments.callDeploymentMethodForProject('updateProjectDeploymentData', project, user, req.query);
            project =
                env || format === 'simple'
                    ? await Project.simpleProjectObjectForResponse(project, env, user)
                    : await Project.projectObjectForResponse(project, user);
            res.json(project);
        } catch (error) {
            logger.error('Get Project Failed', { error, projectId });
            res.status(error.status || 500).json(error);
        }
    },
    getProjectPreview: (req, res) => {
        const { id } = req.params;
        const { previewToken, env } = req.query;
        Project.findProjectByIdAndPreviewToken(id, previewToken)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                return res.json(Project.getPreviewFields(project, env));
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    getMyProjects: (req, res) => {
        const allowedQueries = ['deploymentData.container'];

        const user = req.user;
        const ownerId = req.user.id;
        const { query } = req;
        const filter = {};

        Object.keys(query).forEach((queryKey) => {
            if (allowedQueries.includes(queryKey)) {
                filter[queryKey] = { $exists: true };
            }
        });

        return Project.findProjectsForUser(ownerId, filter)
            .then((projects) => {
                if (projects.length > MAX_NUM_PROJECT_UPDATE) {
                    logger.warn('[getMyProjects] large amount projects being updated with updateProjectDeploymentData', {
                        userId: ownerId,
                        projects: projects.length
                    });
                }
                return Promise.all(
                    _.map(projects.slice(0, MAX_NUM_PROJECT_UPDATE), (project) => {
                        return deployments.callDeploymentMethodForProject('updateProjectDeploymentData', project, user);
                    })
                ).then((updatedProjects) => updatedProjects.concat(projects.slice(MAX_NUM_PROJECT_UPDATE)));
            })
            .then(async (projects) => {
                res.json(await Promise.all(projects.map((project) => Project.projectObjectForResponse(project, user))));
            })
            .catch((err) => {
                logger.error('[getMyProjects] error getting projects', { err });
                res.status(err.status || 500).json(err);
            });
    },
    getMyDashboardProjects: async (req, res) => {
        try {
            const allowedQueries = ['deploymentData.container'];

            const user = req.user;
            const ownerId = req.user.id;
            const { query } = req;
            const filter = {
                buildStatus: { $ne: 'draft' },
                'wizard.container.settings.containerTrial': { $ne: true }
            };

            Object.keys(query).forEach((queryKey) => {
                if (allowedQueries.includes(queryKey)) {
                    filter[queryKey] = { $exists: true };
                }
            });

            const projects = await Project.findProjectsForUser(ownerId, filter);
            res.json(await Promise.all(projects.map((project) => Project.projectObjectForResponse(project, user))));
        } catch (err) {
            logger.error('[getMyProjects] error getting projects', { err });
            res.status(err.status || 500).json(err);
        }
    },
    updateProject: (req, res) => {
        const { project } = req.body;
        const user = req.user;
        const { id } = req.params;
        const sanitizedProject = sanitizeProjectInput(project);
        return Project.updateProject(id, sanitizedProject, user.id)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                return Project.projectObjectForResponse(project, user);
            })
            .then((project) => {
                res.json(project);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    duplicateProject: (req, res) => {
        const { id } = req.params;
        const user = req.user;
        return Project.duplicateProject(id, user.id)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                res.json(project);
                analytics.track(
                    'Project Duplicated',
                    {
                        projectId: project.id,
                        userId: user.id,
                        sourceProjectId: id
                    },
                    req.user
                );
            })
            .catch((err) => {
                logger.error('duplicateProject error', { error: err, projectId: id, userId: user ? user.id : null });
                res.status(err.status || 500).json(err);
            });
    },
    redeployProject: (req, res) => {
        const { id: projectId } = req.params;
        const { force, environmentName, previewToken } = req.body;

        return Promise.resolve()
            .then(() => {
                if (!previewToken && !req.user) {
                    throw ResponseErrors.Unauthorized;
                }

                // redeploy could be called either owner/collaborator/admin or any user with providing proper project preview token
                const promise = previewToken
                    ? Project.findProjectByIdAndPreviewToken(projectId, previewToken).then(async (project) => {
                        let user;

                        if (project) {
                            // redeploy in this case should happen on behalf of the owner because, for instance, sanity is reading user connection token
                            user = await User.findUserById(project.ownerId);
                        }

                        return { project, user };
                    })
                    : Project.findProjectByIdAndUser(projectId, req.user, CollaboratorRole.Permission.BASIC_ACCESS).then((project) => ({
                        project,
                        user: req.user
                    }));

                return promise;
            })
            .then(({ project, user }) => {
                if (!project || !user) {
                    throw ResponseErrors.NotFound;
                }
                return deployments
                    .callDeploymentMethodForProject('redeploy', project, user, environmentName, logger, { force })
                    .then(() => {
                        res.json(project);
                        analytics.track(
                            'Redeploy Requested',
                            {
                                projectId: project.id,
                                userId: user.id,
                                containerType: Project.getContainerType(project)
                            },
                            user
                        );
                    });
            })
            .catch((err) => {
                if (req.user) {
                    analytics.track(
                        'Redeploy Request Failed',
                        {
                            projectId,
                            userId: req.user.id
                        },
                        req.user
                    );
                }
                logger.error('error requesting redeploy', { err, projectId, userId: req.user?.id });
                return res.status(err.status || 500).json({ message: err.message });
            });
    },
    deleteProject: (req, res) => {
        const connectedServices = _.get(req, 'body.connectedServices', []);
        const { id } = req.params;
        const user = req.user;

        return Project.findProjectByIdAndUser(id, user, CollaboratorRole.Permission.FULL_ACCESS)
            .then(async (project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                const siteId = _.get(project, 'wizard.deployment.settings.netlifyId');
                const importedNetlifySite = _.get(project, 'importData.dataType') === 'netlify';

                if (importedNetlifySite) {
                    return netlifyService.removeNetlifySite(
                        project,
                        siteId,
                        user.netlifyAccessToken,
                        config.build.stackbitWidgetForImportedSites.enabled
                    );
                } else {
                    if (project.hasSubscription()) {
                        project = await stripeService.cancelSubscription({ project });
                    }
                    if (connectedServices.length) {
                        analytics.track(
                            'Project Delete Connections',
                            {
                                projectId: project.id,
                                userId: user.id,
                                connections: connectedServices
                            },
                            user
                        );
                    }
                    return ProjectService.deleteProjectConnections(project, user, connectedServices);
                }
            })
            .then(({ project, deletedConnections = [] }) => {
                let promise = Promise.resolve();
                const failedConnections = deletedConnections.filter((c) => !c.success).map((c) => c.connectionId);

                if (failedConnections.length) {
                    const successfullyRemoved = deletedConnections.filter((c) => c.success).map((c) => c.connectionId);

                    promise = Project.deleteProject(id, user.id).then(() => {
                        analytics.track(
                            'Project Deleted With Failed Connections',
                            {
                                projectId: id,
                                userId: user.id,
                                failedConnections
                            },
                            req.user
                        );

                        const err = Object.assign({}, ResponseErrors.ProjectNotAllConnectionsWereDeleted);
                        err.data = {
                            deleted: successfullyRemoved,
                            failed: failedConnections
                        };
                        throw err;
                    });
                }

                return promise
                    .then(() => Project.deleteProject(id, user.id))
                    .then(() => {
                        analytics.track(
                            'Project Deleted',
                            {
                                projectId: id,
                                userId: user.id,
                                connections: deletedConnections,
                                containerType: Project.getContainerType(project)
                            },
                            req.user
                        );
                        res.json({ status: 'ok' });
                    });
            })
            .catch((err) => {
                if (err.name === 'ProjectNotAllConnectionsWereDeleted') {
                    return res.status(err.status).json(err);
                }
                if (err.name === 'CastError') {
                    res.status(ResponseErrors.NotFound.status).json(ResponseErrors.NotFound);
                } else {
                    logger.error('Failed to delete project', err);
                    return res.status(err.status || 500).json({ message: 'Failed to delete project' });
                }
            });
    },
    deployProject: (req, res) => {
        const { id } = req.params;
        const user = req.user;
        return ProjectBuildService.deployProject(id, user)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                return Project.projectObjectForResponse(project, user);
            })
            .then((project) => {
                res.json(project);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    createProjectAndDeployPreview: async (req, res) => {
        const user = req.user;
        const { projectParameters, repoInfo, previewBranch, publishBranch } = req.body;
        let project = null;

        try {
            const siteConfig = projectParameters?.config;

            project = await Project.createProject(
                {
                    name: _.lowerCase(repoInfo?.selectedGithubRepo?.name),
                    buildStatus: 'draft',
                    widget: {
                        flatTree: true,
                        realtimeEditor: false,
                        reloadSchemaWithFields: false,
                        hmrReload: false,
                        slateRichTextEnabled: false,
                        // legacy project support which doesn't support such things
                        branchInfoEnabled: true,
                        schemaEditorEnabled: true,
                        codeEditorActionsEnabled: true,
                        codeEditorEnabled: true
                    },
                    'wizard.theme': {
                        id: 'custom',
                        title: null,
                        settings: {
                            source: repoInfo.selectedGithubRepoUrl,
                            commit: null,
                            branch: repoInfo.selectedGithubBranch || 'master',
                            stackbitYmlFound: repoInfo?.stackbitYmlFound,
                            stackbitYmlValid: repoInfo?.stackbitYmlValid,
                            isValidated: repoInfo?.isValidated,
                            isAnalyzed: repoInfo?.isAnalyzed,
                            themeConfig: siteConfig,
                            status: repoInfo?.status || []
                        }
                    },
                    'wizard.repository': {
                        id: 'github',
                        title: 'Github',
                        settings: {
                            sharedUser: false,
                            githubUser: repoInfo.username,
                            repoName: repoInfo.selectedGithubRepo?.name,
                            ownerLogin: repoInfo.selectedGithubRepo?.owner.login,
                            sshURL: repoInfo.selectedGithubRepo?.ssh_url,
                            defaultBranch: repoInfo.selectedGithubRepo?.default_branch
                        }
                    },
                    'wizard.container': {
                        id: 'sharedContainer',
                        title: 'sharedContainer',
                        settings: {
                            imported: true,
                            publishBranch: publishBranch,
                            previewBranch: previewBranch
                        }
                    },
                    'wizard.deployment': {
                        id: null,
                        title: null
                    },
                    'wizard.ssg': {
                        id: siteConfig.ssgName,
                        title: _.upperCase(siteConfig.ssgName)
                    },
                    'wizard.cms': {
                        id: siteConfig.cmsName,
                        title: _.upperCase(siteConfig.cmsName)
                    },
                    'wizard.settings.repoSelectedCount': repoInfo.repoSelectedCount,
                    'settings.isGenericContainer': true
                },
                user
            );

            project = await ProjectBuildService.deployPreview({
                projectId: project.id,
                projectParameters,
                user,
                previewBranch,
                publishBranch
            });

            project = await Project.simpleProjectObjectForResponse(project, null, user);
            sendSlackProjectMessage(config.slack.leadsImportSite, 'Deploy Preview Success', project, user);
            res.json(project);
        } catch (err) {
            sendSlackProjectMessage(config.slack.leadsImportSite, 'Deploy Preview Failed', project ?? {}, user, err.message);
            logger.error('Error creating project and deploying preview', { err });
            res.status(_.get(err, 'status', 500)).json({ message: 'Error creating project and deploying preview' });
        }
    },
    deployPreview: async (req, res) => {
        const { id: projectId } = req.params;
        const user = req.user;
        const { projectParameters, previewBranch, publishBranch } = req.body;

        try {
            let project = await ProjectBuildService.deployPreview({
                projectId,
                projectParameters,
                user,
                previewBranch,
                publishBranch
            });

            project = await Project.simpleProjectObjectForResponse(project, null, user);
            res.json(project);
        } catch (err) {
            logger.error('Error deploying preview', { projectId, err });
            res.status(_.get(err, 'status', 500)).json({ message: 'Error deploying preview' });
        }
    },
    deployWebflow: (req, res) => {
        const { id } = req.params;
        const user = req.user;
        const { projectParameters, environmentVariables, previewBranch, publishBranch } = req.body;
        return ProjectBuildService.deployWebflow({
            projectId: id,
            envVars: environmentVariables,
            projectParameters,
            user,
            previewBranch,
            publishBranch
        })
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                res.json(project);
            })
            .catch((err) => {
                logger.error('Failed to deploy webflow project', err);
                res.status(err.status || 500).json(err);
            });
    },
    buildProject: (req, res) => {
        const user = req.user;
        const { byName } = req.query;
        let { id: projectId } = req.params;

        const projectIdPromise = byName
            ? Project.findProjectByContainerName(projectId).then((project) => {
                if (!project) {
                    const err = {
                        status: 404,
                        name: 'ProjectNotFound',
                        message: `Project with name '${projectId}' not found`
                    };
                    logger.warn(err);
                    return res.status(err.status).json(err.message);
                }
                projectId = project.id;
                return project.id;
            })
            : Promise.resolve(projectId);

        return projectIdPromise
            .then((projectId) => {
                return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.FULL_ACCESS);
            })
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                return project;
            })
            .then((project) => {
                return deployments.callDeploymentMethodForProject('triggerBuild', project, user, { buildType: 'content-only' });
            })
            .then((project) => {
                analytics.track(
                    'Trigger build Success',
                    {
                        projectId: project.id,
                        userId: user.id,
                        containerType: Project.getContainerType(project)
                    },
                    user
                );

                return Project.projectObjectForResponse(project, user);
            })
            .then((project) => {
                res.json(project);
            })
            .catch((err) => {
                analytics.track(
                    'Trigger build Failed',
                    {
                        projectId: projectId,
                        userId: user.id
                    },
                    user
                );
                logger.error('error building', err);
                res.status(err.status || 500).json(err.message);
            });
    },

    publishContent: (req, res) => {
        const user = req.user;
        const { objects, type } = req.body;
        const { env: environmentName } = req.query;
        let { id: projectId } = req.params;

        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.PUBLISH_SITE)
            .then((project) => {
                return publishContentService.publishContent(project, user, { objects, type }, environmentName).then(() => project);
            })
            .then(async (project) => {
                res.json({ status: 'ok' });

                analytics.track(
                    'Publishing content Success',
                    {
                        projectId: project.id,
                        userId: user.id,
                        containerType: Project.getContainerType(project)
                    },
                    user
                );
                await workflowService.notifyRequestedPublishes(project, user);
                await ScoreService.addScoreForAction(`publishContent-${type}`, project.id);
            })
            .catch((err) => {
                analytics.track(
                    'Publishing content Failed',
                    {
                        projectId: projectId,
                        userId: user.id
                    },
                    user
                );
                logger.error('error publishing content', { error: err });
                return res.status(err.status || 500).json({ message: err.message, name: err.name });
            });
    },
    dismissAlert: (req, res) => {
        const { id } = req.params;
        const user = req.user;
        const alertId = req.body.alertId;

        return Project.findProjectByIdAndUser(id, user, CollaboratorRole.Permission.FULL_ACCESS)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                return project.dismissAlert(alertId);
            })
            .then((project) => {
                res.json(project);
                analytics.track(
                    'Project Alert: Dismissed',
                    {
                        alertId: alertId,
                        projectId: project.id,
                        userId: user.id
                    },
                    user
                );
            })
            .catch((err) => {
                logger.error('Project Subscriptions: Alert: failed to dismiss alert', { err, alertId });
                res.status(err.status || 500).json(err);
            });
    },
    checkName: (req, res) => {
        const newName = _.get(req.query, 'name', '').trim().toLowerCase();

        return Promise.resolve()
            .then(() => {
                if (!newName) {
                    throw ResponseErrors.NameNotProvided;
                }
                if (!validateSiteName(newName)) {
                    throw ResponseErrors.NameIsWrong;
                }
            })
            .then(() => Project.findProjectByContainerName(newName))
            .then((containerProject) => {
                if (containerProject) {
                    throw ResponseErrors.NameIsOccupied;
                }
                res.json({ status: 'ok' });
            })
            .catch((err) => {
                logger.error('Container: Failed to rename project', { err });
                res.status(err.status || 500).json(err);
            });
    },
    renameProject: (req, res) => {
        const { id } = req.params;
        const user = req.user;
        const newName = _.get(req.body, 'name', '').trim().toLowerCase();

        return Promise.resolve()
            .then(() => {
                if (!newName) {
                    throw ResponseErrors.NameNotProvided;
                }
                if (!validateSiteName(newName)) {
                    throw ResponseErrors.NameIsWrong;
                }
            })
            .then(() => Project.findProjectByContainerName(newName))
            .then((containerProject) => {
                if (containerProject) {
                    throw ResponseErrors.NameIsOccupied;
                }
            })
            .then(() => Project.findProjectByIdAndUser(id, user, CollaboratorRole.Permission.FULL_ACCESS))
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                const isContainerProject = _.get(project, 'deploymentData.container');
                if (!isContainerProject) {
                    throw ResponseErrors.NotContainerProject;
                }

                const siteName = _.get(project, 'deploymentData.container.name');
                const bucket = _.get(project, 'deploymentData.container.bucket', config.container.bucket);
                const fastlySpaceId = _.get(project, 'deploymentData.container.fastlySpaceId');

                return renameSite(siteName, bucket, fastlySpaceId, newName, logger)
                    .then(() => {
                        const url = getSiteUrl(newName, _.get(project, 'deploymentData.container.lastPreviewId'));
                        return Project.updateSiteUrl(project.id, url);
                    })
                    .then((project) => {
                        project.name = newName;
                        project.deploymentData.container.name = newName;
                        project.deploymentData.container.url = project.siteUrl;

                        analytics.track(
                            'Container Project Rename Success',
                            {
                                projectId: project.id,
                                userId: user.id,
                                containerType: Project.getContainerType(project)
                            },
                            user
                        );

                        return Project.updateProject(id, project, project.ownerId);
                    });
            })
            .then(async (project) => {
                res.json(await Project.projectObjectForResponse(project, user));
            })
            .catch((err) => {
                logger.error('Container: Failed to rename project', { err });
                return res.status(err.status || 500).json({ message: 'Failed to rename project' });
            });
    },
    githubWebhook: async (req, res, next) => {
        res.json({ status: 'ok' });

        try {
            const { id } = req.params;
            let webhookId = req.body.repository.full_name;

            let projects;

            // handling deprecated webhook route
            // /project/:id/webhooks/github
            if (id) {
                const project = await Project.findById(id);
                projects = project ? [project] : [];
                // handling route
                // /webhooks/github
            } else {
                const event = req.body;
                // when repo transferred repository.full_name reference to new user, while in DB webhook has old stackbit-projects owner name
                // use old webhook id to find projects
                // projects webhooks will updated with new name
                if (event.action === 'transferred') {
                    const repoName = req.body.repository.name;
                    webhookId = `${config.container.shared.projectsGithubUser}/${repoName}`;
                }
                projects = await Project.findProjectsByWebhook('github', webhookId);
            }
            if (!projects.length) {
                const data = id ? { projectId: id } : { webhookId };
                return analytics.anonymousTrack('Webhook for deleted project - Github', data, id || webhookId);
            }

            return Promise.all(
                projects.map(async (project) => {
                    // todo use method to handle search not only by owner id
                    const user = await User.findUserById(project.ownerId);

                    if (!user) {
                        return analytics.anonymousTrack(
                            'Webhook for project without owner - Github',
                            { projectId: project.id },
                            id || webhookId
                        );
                    }

                    analytics.track(
                        'Webhook: Github',
                        {
                            projectId: project.id,
                            userId: user.id
                        },
                        user
                    );

                    return repositoryTypes.callRepositoryMethodForProject('onWebhook', project, user, req);
                })
            );
        } catch (e) {
            return next(e);
        }
    },
    buildWebhook: (req, res) => {
        const { id, event } = req.params;

        // Return ok asynchronously in order not to break the build
        res.json({ status: 'ok' });

        Project.findById(id).then((project) => {
            if (!project) {
                return analytics.anonymousTrack('Webhook for deleted project - build', { projectId: id, event: event }, id);
            }
            return deployments.callDeploymentMethodForProject('setDeploymentBuildProgress', project, event, req.body).then(() => {
                return User.findUserById(project.ownerId).then((user) => {
                    analytics.track(
                        'Webhook: build',
                        {
                            event: event,
                            projectId: id,
                            userId: user.id
                        },
                        user
                    );
                });
            });
        });
    },
    projectWebhook: (req, res) => {
        const { id, type } = req.params;
        Project.findById(id).then((project) => {
            if (!project) {
                return analytics.anonymousTrack(`Webhook for deleted project - ${type}`, { projectId: id }, id);
            }

            return User.findUserById(project.ownerId).then((user) => {
                analytics.track(
                    `Webhook: ${type}`,
                    {
                        projectId: id,
                        userId: user.id
                    },
                    user
                );

                return cmsTypes.baseOnWebhook(project, user, req);
            });
        });
        res.json({ status: 'ok' });
    },
    netlifyWebhook: (req, res, next) => {
        res.json({ status: 'ok' });
        const { id } = req.params;
        const body = req.body;
        return Project.findById(id)
            .then((project) => {
                if (!project) {
                    return analytics.anonymousTrack('Webhook for deleted project - Netlify', { projectId: id, state: body.state }, id);
                }
                if (project.buildStatus === 'build-failed') {
                    return analytics.anonymousTrack('Webhook for failed project - Netlify', { projectId: id, state: body.state }, id);
                }

                return User.findUserById(project.ownerId).then((user) => {
                    analytics.track(
                        'Webhook: Netlify',
                        {
                            projectId: id,
                            userId: user.id,
                            state: body.state
                        },
                        user
                    );

                    return deployments['netlify'].onWebhook(project, user, req);
                });
            })
            .catch(next);
    },

    containerWebhook: (req, res, next) => {
        //TODO authenticate request
        res.json({ status: 'ok' });
        const { id, environment } = req.params;
        const body = req.body;
        return Project.findOneWithDeleted({ _id: id })
            .then((project) => {
                if (!project) {
                    logger.warn('Webhook for deleted project - Container Webhook', { projectId: id });
                    return;
                }
                return User.findUserById(project.ownerId).then((user) => {
                    logger.debug('Webhook: Container', { projectId: id, body });
                    return deployments['sharedContainer'].onWebhook(project, user, req, environment);
                });
            })
            .catch(next);
    },
    googleWebhook: (req, res) => {
        const { id } = req.params;
        const resourceState = req.headers['x-goog-resource-state'];
        const changes = _.get(req, 'headers.x-goog-changed', '').split(',');
        const valuedTypes = ['content'];
        const shouldRecord = resourceState === 'update' && changes.some((c) => valuedTypes.includes(c));

        res.json({ status: 'ok' });

        return Project.findById(id)
            .then((project) => {
                if (!project) {
                    return analytics.anonymousTrack('Webhook for deleted project - Google Webhook', { projectId: id }, id);
                }

                const deploymentData = _.get(project, 'deploymentData.container');

                if (!deploymentData) {
                    throw new Error(`No deployment data for project ${project.id} triggered by google webhook`);
                }

                if (!shouldRecord) {
                    return project;
                }

                return User.findUserById(project.ownerId)
                    .then((user) => {
                        const docId = _.get(project, 'importData.settings.docId');
                        return Promise.all([
                            googleService.validateWatcher(project, user),
                            googleService.getFileLatestRevision(docId, user),
                            user,
                            docId
                        ]);
                    })
                    .then(([watcher, version, user, docId]) => {
                        analytics.track(
                            'Google Docs Webhook triggered',
                            {
                                projectId: project.id,
                                userId: user.id,
                                docId,
                                version
                            },
                            user
                        );

                        return Project.updateDeploymentData(id, 'container', {
                            'googledocs.contentVersion': version,
                            'googledocs.publishedAt': new Date()
                        });
                    });
            })
            .catch((err) => {
                logger.error(err);
            });
    },
    refreshContent: (req, res) => {
        const { id: projectId } = req.params;

        res.json({ status: 'ok' });

        return Project.findProjectById(projectId)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                return User.findUserById(project.ownerId).then((user) => {
                    return deployments.callDeploymentMethodForProject('refreshContent', project, user, logger).then(() => {
                        analytics.track(
                            'Refresh Content Requested',
                            {
                                projectId: project.id,
                                userId: user.id
                            },
                            user
                        );
                    });
                });
            })
            .catch((err) => {
                logger.error('Error refreshing content webhook', { err });
            });
    },
    contentVersion: (req, res, next) => {
        const { id } = req.params;
        const { apiKey } = req.body;
        const { env } = req.query;
        const environmentName = env !== 'master' ? env : null;
        return Project.findProjectByIdAndApiKey(id, apiKey)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                return cmsTypes.baseInvokeContentSourcesWithProject('updateContentVersion', project, environmentName).then((project) => {
                    const cmsId = _.get(project, 'wizard.cms.id');
                    return project.getDeploymentData(`${cmsId}.contentVersion`, environmentName);
                });
            })
            .then((contentVersion) => {
                res.json(contentVersion);
            })
            .catch((err) => {
                if (err.name === ResponseErrors.NotFound.name) {
                    return res.status(err.status).json(err);
                }
                throw err;
            })
            .catch(next);
    },
    makeAction: (req, res) => {
        const { action, data } = req.body;
        const originPath = req.query.path;
        const projectId = req.params.id;
        const user = req.user;
        const permission = actionPermission[action];

        if (!permission) {
            const error = ResponseErrors.ActionError({ message: 'No permissions for action' });
            logger.error('[Project makeAction] failed', { error, userId: req.user.id, projectId, action });
            return res.status(error.status).json(error);
        }

        return Project.findProjectByIdAndUser(projectId, req.user, permission)
            .then(async (project) => {
                if (!project) {
                    throw new errorUtils.ResponseError('NotFound');
                }

                const isSubscriptionEnded = await project.isSubscriptionEnded();
                if (isSubscriptionEnded) {
                    throw new errorUtils.ResponseError('ProjectSubscriptionHasEnded');
                }

                const isOwnerOrCollaborator = (await project.getCollaboratorRole(user)).isAuthorized(
                    CollaboratorRole.Permission.COLLABORATOR
                );

                return makeAction(action, project, user, data, originPath).then((result) => {
                    res.json(result);
                    if (isOwnerOrCollaborator) {
                        analytics.track(
                            'Project Action Complete',
                            {
                                projectId: project.id,
                                userId: req.user.id,
                                action: action
                            },
                            req.user
                        );
                        ScoreService.addScoreForAction(action, project.id);
                    }
                });
            })
            .catch((err) => {
                const isDescribedError = err.data?.name && err.data?.message;
                const error = isDescribedError ? err.data : ResponseErrors.ActionError({ message: err.message || _.startCase(`${action} failed`) });
                const clearData = _.omit(data, ['schema']);
                logger.error('[Project makeAction] failed', { error: err, userId: req.user.id, projectId, action, data: clearData });
                return res.status(err.status || 500).json(error);
            });
    },
    hasCmsAccess: (req, res, next) => {
        const user = req.user;
        const projectId = req.params.id;
        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                return cmsTypes.baseInvokeContentSourcesWithProject('hasAccess', project, user).then((access) => {
                    return res.status(200).json(access);
                });
            })
            .catch((err) => {
                logger.error('hasCmsAccess error', { error: err });
                return res.status(err.status || 500).json({ message: 'Failed to check access' });
            });
    },
    hasDeploymentAccess: (req, res, next) => {
        const user = req.user;
        const projectId = req.params.id;
        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                const buildLogger = BuildLogger(projectId, user.id);
                return deployments.callPureDeploymentMethodForProject('hasAccess', project, user, buildLogger).then((access) => {
                    return res.status(200).json(access);
                });
            })
            .catch((err) => {
                logger.error('hasDeploymentAccess error', { error: err });
                return res.status(err.status || 500).json({ message: 'Failed to check access' });
            });
    },
    canStartContainer: async (req, res) => {
        const user = req.user;
        const projectId = req.params.id;
        const { previewToken } = req.query;

        try {
            if (!previewToken && !user) {
                return res.json({ canStart: false, reason: 'NO_ACCESS' });
            }
            const project = previewToken
                ? await Project.findProjectByIdAndPreviewToken(projectId, previewToken)
                : await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS);
            if (!project) {
                return res.json({ canStart: false, reason: 'NOT_FOUND' });
            }

            if (project?.wizard?.repository?.settings?.sharedUser === true) {
                res.json({ canStart: true });
            } else {
                const isOwner = user?.id === project.ownerId.toString();
                const owner = isOwner ? user : await User.findUserById(project.ownerId);
                if (!owner.githubAccessToken) {
                    return res.json({ canStart: false, reason: 'NO_GITHUB', isOwner });
                }

                const githubUser = await GithubService.getGithubUser(owner.githubAccessToken).catch(() => null);
                const hasGithub = Boolean(githubUser);

                if (hasGithub) {
                    res.json({ canStart: true });
                } else {
                    res.json({ canStart: false, reason: 'NO_GITHUB', isOwner });
                }
            }
        } catch (err) {
            logger.error('canStartContainer error', { error: err });
            return res.status(err.status || 500).json({ message: 'Failed to check if container can start' });
        }
    },
    hasChanges: (req, res) => {
        const user = req.user;
        const { id: projectId } = req.params;
        const { objects, type } = req.body;
        const { env: environmentName } = req.query;

        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS).then((project) => {
            return cmsTypes
                .baseInvokeContentSourcesWithProject('hasChanges', project, user, { objects, type }, environmentName)
                .then(({ hasChanges }) => {
                    return res.status(200).json({ hasChanges });
                })
                .catch((err) => {
                    logger.error('hasChanges error', { error: err });
                    return res.status(err.status || 500).json({ message: 'Failed to check content changes' });
                });
        });
    },
    sendTrialEmail: (req, res) => {
        const projectId = req.params.id;
        const email = 'admin@stackbit.com';

        return Project.findProjectById(projectId)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                mailgunService
                    .sendContainerTrialEmail(email, project)
                    .then((mailgunResponse) => {
                        return res.status(200).json(mailgunResponse);
                    })
                    .catch((err) => {
                        return res.status(err.status || 500).json(err);
                    });
            })
            .catch((err) => {
                return res.status(err.status || 500).json(err);
            });
    },

    handleStripeWebhook: async (req, res, next) => {
        try {
            await stripeService.handleWebhookEvent({
                body: req.rawBody,
                headers: req.headers
            });

            return res.status(200).end();
        } catch (error) {
            logger.error('Stripe Webhook Error', { error });

            return res.status(500).json(error);
        }
    },

    async startTrial(req, res) {
        const projectId = req.params.id;
        const {
            body: { tierId, setTrialStartedRecently },
            user
        } = req;

        try {
            let project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BILLING);
            if (!project) {
                throw ResponseErrors.NotFound;
            }
            if (!customerTierService.isEligibleForTrial(tierId, project)) {
                throw ResponseErrors.NotEligibleForTrial;
            }
            // This is a special workaround for paying Value customers that want to
            // try the Business plan. If we see that this happens more than once or twice,
            // we'll make this more official.
            if (project.subscription.tierId === '2021a-pro' && tierId === '2021a-business-trial') {
                project = await Project.setTierOverrides(project, {
                    collaborators: 9,
                    environments: 4,
                    abTesting: true,
                    collaboratorRoles: true
                });
                project = await Project.addCurrentTierToPastTiers(project, '2021a-business-trial');
                await sendPlansEmail(project, project.subscription.tierId, PLANS_EMAIL_EVENT.STARTED);
                // TODO send email to Stackbit
            } else {
                project = await Project.startTrial(project, tierId, setTrialStartedRecently);
            }
            res.status(200).json();
            analytics.track(
                'Trial Started',
                {
                    projectId: projectId,
                    userId: user.id,
                    userEmail: user.email,
                    tierId,
                    projectUrl: project.siteUrl
                },
                user
            );
        } catch (error) {
            logger.error('Project Subscriptions: start trial failed', { error });
            return res.status(error.status || 500).json(error);
        }
    },

    async unsetSubscriptionFlag(req, res) {
        const projectId = req.params.id;
        const {
            body: { flag }
        } = req;

        try {
            await Project.unsetSubscriptionFlag(projectId, flag);
            res.status(200).json();
        } catch (error) {
            logger.error('Project Subscriptions: unset subscription flag failed', { error });
            return res.status(error.status || 500).json(error);
        }
    },

    createSubscription: async (req, res, options = {}) => {
        const projectId = req.params.id;
        const { body: data, user } = req;

        try {
            const project = await Project.findProjectById(projectId);

            if (!project) {
                return res.status(404).end();
            }

            const isAuthorized = user && (await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BILLING));

            if (!isAuthorized) {
                const paymentLinkToken = await project.getPaymentLinkTokenOrGenerateNew();

                if (paymentLinkToken !== data.token) {
                    return res.status(401).end();
                }
            }

            const session = await stripeService.createCheckoutSessionForNewSubscription({
                cancelUrl: data.cancelUrl,
                forceNewCustomer: options.createCustomer,
                planId: data.planId,
                project,
                successUrl: data.successUrl,
                tierId: data.tierId,
                user
            });

            return res.status(200).json({ sessionId: session.id });
        } catch (error) {
            // We tried to associate an existing customer ID, but Stripe is
            // telling us that the ID does not exist. We repeat the process
            // but create a new customer.
            if (error.type === 'StripeInvalidRequestError' && error.code === 'resource_missing' && error.param === 'customer') {
                return module.exports.createSubscription(req, res, {
                    ...options,
                    createCustomer: true
                });
            }

            logger.error('Project Subscriptions: createSubscription failed', { error });

            return res.status(error.status || 500).json(error);
        }
    },

    editSubscription: async (req, res) => {
        const projectId = req.params.id;
        const data = req.body;
        const user = req.user;

        if (data.type === 'updatePaymentMethod') {
            try {
                const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BILLING);

                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                const session = await stripeService.createCheckoutSessionForChangingPaymentMethod({
                    cancelUrl: data.cancelUrl,
                    project,
                    successUrl: data.successUrl,
                    user
                });

                return res.status(200).json({ sessionId: session.id });
            } catch (error) {
                logger.error('Project Subscriptions: updatePaymentMethod failed', { error });

                return res.status(error.status || 500).json(error);
            }
        }

        if (data.type === 'updateTier') {
            try {
                const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BILLING);

                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                await stripeService.updateTier({
                    planId: data.planId,
                    project,
                    tierId: data.tierId
                });

                return res.status(200).json({ updated: true });
            } catch (error) {
                logger.error('Project Subscriptions: updateTier failed', { error });

                return res.status(error.status || 500).json(error);
            }
        }

        if (data.type === 'cancel') {
            try {
                const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BILLING);

                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                if (project.subscription.id) {
                    await stripeService.cancelSubscription({
                        project
                    });
                } else {
                    Project.cancelSubscription(project._id, { immediate: true });
                }

                return res.status(200).json({ cancelled: true });
            } catch (error) {
                logger.error('Project Subscriptions: cancel failed', { error });

                return res.status(error.status || 500).json(error);
            }
        }

        return res.status(400).json({ message: 'Action type missing from the request' });
    },

    getSubscription: async (req, res) => {
        const projectId = req.params.id;
        const user = req.user;

        try {
            const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS);

            if (!project) {
                throw ResponseErrors.NotFound;
            }

            const subscription = await stripeService.getSubscription(project);

            if (!subscription) {
                throw ResponseErrors.NotFound;
            }

            return res.status(200).json(subscription);
        } catch (error) {
            logger.error('Project Subscriptions: getSubscription failed', { error });

            return res.status(error.status || 500).json(error);
        }
    },

    splitTestAction: (req, res) => {
        const projectId = req.params.id;
        const action = req.params.action;
        const user = req.user;
        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.MANAGE_SPLIT_TEST)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                if (action === 'provision') {
                    return SplitTestService.provisionSplitTest(project, user, req.body, res);
                } else if (action === 'start') {
                    return SplitTestService.startSplitTest(project, user, req.body, res);
                } else if (action === 'finish') {
                    return SplitTestService.finishSplitTest(project, user, req.body, res);
                } else if (action === 'cleanup') {
                    return SplitTestService.cleanupSplitTest(project, user, req.body, res);
                } else {
                    throw ResponseErrors.UnsupportedOperation;
                }
            })
            .catch((err) => {
                logger.error('Split test error', { err });
                return res.status(err.status || 500).json(err);
            });
    },

    schedulePublish: (req, res) => {
        const projectId = req.params.id;
        const user = req.user;
        const scheduleToken = uuid();
        const { originalScheduledDate, utcScheduledDate } = req.body;

        logger.debug('Schedule publishing', { projectId, userId: user.id, originalScheduledDate, utcScheduledDate });

        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.PUBLISH_SITE)
            .then(async (project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                const isSubscriptionEnded = await project.isSubscriptionEnded();
                if (isSubscriptionEnded) {
                    throw ResponseErrors.ProjectSubscriptionHasEnded;
                }

                if (!project.checkTierAllowanceForFeature('scheduledPublish')) {
                    throw ResponseErrors.ProjectTierExceeded;
                }

                if (_.get(project, 'deploymentData.container.publishScheduled')) {
                    throw new Error('Publish already scheduled');
                }

                return publishContentService.schedulePublish({ project, user, utcScheduledDate, originalScheduledDate, scheduleToken });
            })
            .then(() => {
                return Project.updateDeploymentData(projectId, 'container', {
                    publishScheduled: true,
                    originalScheduledDate: new Date(originalScheduledDate),
                    utcScheduledDate: new Date(utcScheduledDate),
                    scheduleToken
                });
            })
            .then(() => {
                res.status(200).json();
                logger.debug('schedulePublish scheduled', { projectId, userId: user.id });
                analytics.track(
                    'Project Schedule Publishing Scheduled',
                    {
                        projectId: projectId,
                        userId: user.id,
                        utcScheduledDate: new Date(utcScheduledDate)
                    },
                    user
                );
                ScoreService.addScoreForAction('scheduledPublish', projectId);
            })
            .catch((err) => {
                logger.error('schedulePublish error', { error: err, projectId, userId: user.id });
                return res.status(err.status || 500).json(err.message);
            });
    },

    removeScheduledPublish: (req, res) => {
        const projectId = req.params.id;
        const user = req.user;

        logger.debug('Cancel Scheduled publishing', { projectId, userId: user.id });

        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.PUBLISH_SITE)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }

                if (!_.get(project, 'deploymentData.container.publishScheduled')) {
                    throw new Error('Scheduled publish already published or canceled');
                }

                return publishContentService.removeScheduledPublish({ project });
            })
            .then(() => {
                return Project.updateDeploymentData(projectId, 'container', {
                    publishScheduled: false,
                    originalScheduledDate: null,
                    utcScheduledDate: null,
                    scheduleToken: null
                });
            })
            .then(() => {
                logger.debug('cancelScheduledPublishing canceled', { projectId, userId: user.id });
                analytics.track(
                    'Project Schedule Publishing Canceled',
                    {
                        projectId: projectId,
                        userId: user.id
                    },
                    user
                );
                return res.status(200).json();
            })
            .catch((err) => {
                logger.error('cancelScheduledPublishing error', { error: err, projectId, userId: user.id });
                return res.status(err.status || 500).json(err.message);
            });
    },

    publishContentWithToken: (req, res) => {
        const { projectId, userId, scheduledToken, returnImmediately } = req.body;
        logger.debug('Publishing content with token', { projectId, userId, scheduledToken, returnImmediately });

        if (returnImmediately) {
            res.status(200).json({});
            return publishContentWithToken(req, res).catch((err) => {
                logger.error('publishContentWithToken error', { error: err, projectId, userId });
            });
        }

        return publishContentWithToken(req, res)
            .then(() => {
                return res.status(200).json({});
            })
            .catch((err) => {
                logger.error('publishContentWithToken error', { error: err, projectId, userId });
                return res.status(err.status || 500).json(err);
            });
    },

    requestPublish: async (req, res, next) => {
        const { user } = req;
        const { projectId, requestText } = req.body;
        try {
            const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.EDIT_ACCESS);
            if (!project) {
                throw ResponseErrors.NotFound;
            }
            await workflowService.addRequestedPublish(project, user, requestText);
            res.status(200).json({});
        } catch (error) {
            logger.error('Request Publish failed', { error, projectId });
            res.status(error.status || 500).json({ message: error.message, name: error.name });
        }
    },

    projectLogs: (req, res) => {
        const user = req.user;
        const { id: projectId } = req.params;
        const { nextToken, env: environmentName } = req.body;

        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                return deployments.callDeploymentMethodForProject('getLogs', project, nextToken, environmentName).then((result) => {
                    res.json(result);
                });
            })
            .catch((err) => {
                if (err !== ResponseErrors.LogsNotAvailable && err !== ResponseErrors.NotFound) {
                    logger.error('error requesting logs', { err, projectId, userId: user.id, environmentName });
                }
                return res.status(err.status || 500).json({ message: err.message });
            });
    },

    projectHealth: async (req, res) => {
        const user = req.user;
        const { id: projectId } = req.params;
        const { env: environmentName, warmup, previewToken } = req.query;

        try {
            if (!previewToken && !user) {
                throw ResponseErrors.Unauthorized;
            }

            const project = await (previewToken
                ? Project.findProjectByIdAndPreviewToken(projectId, previewToken)
                : Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS));

            if (!project) {
                throw ResponseErrors.NotFound;
            }

            const result = await deployments.callDeploymentMethodForProject('getHealth', project, user, environmentName, warmup);
            res.json(result);
        } catch (err) {
            logger.error('error checking health', { err, projectId, userId: user?.id, environmentName });
            res.status(err.status || 500).json({ message: err.message });
        }
    },

    analyzeRepo: (req, res) => {
        const user = req.user;
        const { repoUrl, branch, options, initializer } = req.body;
        logger.debug('Analyze repo', { repoUrl });
        return analyze(user, repoUrl, branch, options, initializer)
            .then((result) => {
                res.json(result);
            })
            .catch((err) => {
                logger.error('error analyzing repo', { err });
                return res.status(err.status || 500).json({ message: 'Error analyzing the repo' });
            });
    },

    hasChangesOnEnvironments: (req, res) => {
        const user = req.user;
        const { id: projectId } = req.params;

        return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS)
            .then((project) => {
                if (!project) {
                    throw ResponseErrors.NotFound;
                }
                const environments = projectUtils.getProjectEnvironments(project);
                return Promise.all(
                    environments.map((env) => {
                        return cmsTypes.baseInvokeContentSourcesWithProject('hasChanges', project, user, { objects: [], type: 'all' }, env);
                    })
                ).then((changes) => {
                    res.json({ hasChanges: changes.some(({ hasChanges }) => hasChanges) });
                });
            })
            .catch((err) => {
                return res.status(err.status || 500).json({ message: err.message });
            });
    },

    updateStackbitSchema: async (req, res) => {
        const user = req.user;
        const { id: projectId, environment } = req.params;
        try {
            const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.EDIT_ACCESS);
            if (!project) {
                throw ResponseErrors.NotFound;
            }
            res.status(200).json(await updateStackbitSchema(project, user, req.body, environment));
        } catch (error) {
            logger.error('Update Stackbit schema failed', { error, projectId });
            res.status(error.status || 500).json({ message: error.message, name: error.name });
        }
    },

    generateStackbitSchema: async (req, res) => {
        const user = req.user;
        const { id: projectId, environment } = req.params;
        try {
            const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.EDIT_ACCESS);
            if (!project) {
                throw ResponseErrors.NotFound;
            }
            res.status(200).json(await generateStackbitSchema(project, user, environment));
        } catch (error) {
            logger.error('Update Stackbit schema failed', { error, projectId });
            res.status(error.status || 500).json({ message: error.message, name: error.name });
        }
    },

    getProjectConfig: async (req, res) => {
        const { id: projectId, environment } = req.params;
        // todo: remove req.query; left for backward compatibility for few days
        const key = req.headers['authorization']?.split(' ')[1] || req.query.key;
        try {
            const project = await Project.findProjectByIdAndApiKey(projectId, key, 'container-key');
            if (!project) {
                throw ResponseErrors.NotFound;
            }
            const user = await User.findUserById(project.ownerId);
            const env = await deployments.callDeploymentMethodForProject('getEnvironmentVariables', project, user, environment, logger);
            res.status(200).json(env);
        } catch (error) {
            logger.error('Get Environment Failed', { error, projectId });
            res.status(error.status || 500).json({ message: error.message, name: error.name });
        }
    },

    getConfig: async (req, res) => {
        const user = req.user;
        const { id: projectId, environment } = req.params;

        try {
            const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.EDIT_ACCESS);
            if (!project) {
                throw new errorUtils.ResponseError('NotFound');
            }
            const siteConfig = await getSiteConfig(project, user, environment);
            res.status(200).json({
                ...(siteConfig ? _.pick(siteConfig, ['ssgVersion', 'nodeVersion', 'devCommand']) : {})
            });
        } catch (error) {
            logger.error('Get Site Config Failed', { error, projectId });
            res.status(error.status || 500).json({ message: error.message, name: error.name });
        }
    },

    updateConfig: async (req, res) => {
        const user = req.user;
        const { id: projectId, environment } = req.params;
        const data = req.body;

        try {
            const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.EDIT_ACCESS);
            if (!project) {
                throw new errorUtils.ResponseError('NotFound');
            }
            if (Object.keys(data).find((key) => ['ssgVersion', 'nodeVersion', 'devCommand'].includes(key))) {
                await updateSiteConfig(project, user, environment, { data });
            } else {
                // todo process env vars, refresh command, cms related values here
            }

            // legacy support
            // unset NODE_VERSION because it's already part of stackbit yaml
            const containerEnvVars = project.getDeploymentData('container.env', environment);
            if (data.nodeVersion && containerEnvVars?.NODE_VERSION) {
                await Project.updateDeploymentData(
                    project._id,
                    'container',
                    {
                        env: _.omit(containerEnvVars, 'NODE_VERSION')
                    },
                    environment
                );
            }

            res.status(200).json({ status: 'ok' });
        } catch (error) {
            logger.error('Update Config Failed', { error, projectId });
            res.status(error.status || 500).json({ message: error.message, name: error.name });
        }
    },

    addProjectToProjectGroup: async (req, res) => {
        try {
            const { projectGroupId, id } = req.params;
            const projectObjectId = mongoose.Types.ObjectId(id);
            const projectGroupObjectId = mongoose.Types.ObjectId(projectGroupId);

            if (!projectGroupId) {
                logger.error('[addProjectToProjectGroup] no projectGroupId provided', { id });
                throw ResponseErrors.UnsupportedOperation;
            }

            if (!id) {
                logger.error('[addProjectToProjectGroup] no id provided', { projectGroupId });
                throw ResponseErrors.UnsupportedOperation;
            }

            await Project.addProjectToProjectGroup(projectObjectId, projectGroupObjectId);
            res.status(200).json();
        } catch (err) {
            logger.error('Organization: [addProjectToProjectGroup] Error Add Project To Project Group', { err: err?.message });
            res.status(err.status || 500).json(err);
        }
    },

    removeProjectFromProjectGroup: async (req, res) => {
        try {
            const { projectGroupId, id } = req.params;
            const projectObjectId = mongoose.Types.ObjectId(id);
            const projectGroupObjectId = mongoose.Types.ObjectId(projectGroupId);

            if (!projectGroupId) {
                logger.error('[removeProjectFromProjectGroup] no projectGroupId provided', { id });
                throw ResponseErrors.UnsupportedOperation;
            }

            if (!id) {
                logger.error('[removeProjectFromProjectGroup] no id provided', { projectGroupId });
                throw ResponseErrors.UnsupportedOperation;
            }

            await Project.removeProjectFromProjectGroup(projectObjectId, projectGroupObjectId);
            res.status(200).json();
        } catch (err) {
            logger.error('Organization: [removeProjectFromProjectGroup] Error Deleting Project From Project Group', { err: err?.message });
            res.status(err.status || 500).json(err);
        }
    },

    handleFormSubmission: async (req, res) => {
        const { id: projectId } = req.params;

        try {
            const contactToken = req.body['form-destination'];
            const project = await Project.findProjectById(projectId);

            if (!project) {
                throw new errorUtils.ResponseError('NotFound');
            }

            // v2 contact form
            const deploymentId = project?.wizard?.deployment?.id;
            const secret = await project.getDeploymentData(`${deploymentId}.contactFormSecret`);
            const payload = await projectUtils.readJWTToken(contactToken, secret);

            if (!payload.email) {
                throw new errorUtils.ResponseError('NotFound');
            }

            const messageFields = _.omit(req.body, ['name', 'email', 'projectId', 'form-name', 'form-destination']);
            const message = Object.entries(messageFields)
                .map(([key, value]) => `${_.startCase(key)}: ${value}`)
                .join('\n');

            await sendContactFormEmail(payload.email, {
                projectName: project.name,
                name: req.body.name,
                email: req.body.email,
                text: message
            });

            analytics.anonymousTrack(
                'Contact Form Submitted',
                {
                    formName: req.body['form-name']
                },
                projectId
            );

            res.status(200).json({ status: 'ok' });
        } catch (error) {
            analytics.anonymousTrack(
                'Contact Form Submission Failed',
                {
                    formName: req.body['form-name']
                },
                projectId
            );

            logger.error('Handle form submission failed', { error, projectId, formData: req.body });

            if (ResponseErrors[error.name]) {
                return res.status(error.status).json({ message: error.message });
            }

            return res.status(500).json({ message: 'Error processing contact form data' });
        }
    }
};

const publishContentWithToken = (req) => {
    const { projectId, userId, scheduledToken } = req.body;
    return User.findUserById(userId)
        .then((user) => {
            return Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.PUBLISH_SITE).then((project) => {
                if (_.get(project, 'deploymentData.container.scheduledToken') !== scheduledToken) {
                    throw new Error('No access to publishing');
                }

                if (!_.get(project, 'deploymentData.container.publishScheduled')) {
                    throw new Error('Scheduled publish canceled or finished');
                }

                return Project.updateDeploymentData(projectId, 'container', {
                    publishScheduled: false
                }).then(async (project) => {
                    await publishContentService.publishContent(project, user, { objects: [], type: 'all' }).then(() => user);
                    await workflowService.notifyRequestedPublishes(project, user);
                    return project;
                });
            });
        })
        .then(async (user) => {
            analytics.track(
                'Project Content Publishing through token done',
                {
                    projectId: projectId,
                    userId: userId
                },
                user
            );
            logger.debug('publishContentWithToken published', { projectId, userId });
        });
};
