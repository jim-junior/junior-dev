import _ from 'lodash';
import crypto from 'crypto';
import sshpk from 'sshpk';
import util from 'util';
import uuid from 'uuid/v4';
import winston from 'winston';
import config from '../../../config';
import Project from '../../../models/project.model';
import environmentsService from '../environments-service';
import containerService from '../container-service';
import * as orchestrator from '../container-orchestration-service';
import repositoryTypes from '../repositories';
import analytics from '../../analytics/analytics';
import projectUtils from '../../project-services/project-utils';
import logger from '../../logger';
import gitRepo from '../../github-services/github-repo';
import ResponseErrors from '../../../routers/response-errors';
import codeUtils from '../../utils/code.utils';
import forestryService from '../../forestry-services/forestry-service';
import { IProjectDoc } from '../../../models/project.model';
import { IUserDoc } from '../../../models/user.model';
import { getProjectPreviewContainerService } from '../preview-containers';

// A temporary workaround for cyclic dependencies between deployment and other services
function getCMSService() {
    return require('../cmss');
}

function getDeploymentService() {
    return require('./index');
}

function getFactoryService() {
    return require('../factory-service');
}

function getSplitService() {
    return require('../split-test-service');
}

async function generateKeys() {
    const { privateKey, publicKey } = await util.promisify(crypto.generateKeyPair)('rsa', {
        modulusLength: 4096,
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem'
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem',
        }
    });
    return {
        privateKey,
        publicKey: sshpk.parseKey(publicKey, 'pem').toString('ssh')
    };
}

function getUserDefinedEnv(project: IProjectDoc) {
    let result: Record<string, string> = {};
    if (project.settings.hasStackbitPull) {
        return result;
    } else if (project.wizard?.theme?.settings?.themeConfig?.import) {
        const cmsImportType = project.wizard?.theme?.settings?.themeConfig?.import.type;
        if (!['contentful', 'sanity'].includes(cmsImportType)) {
            throw new Error(`CMS Import Error: import.type not supported: ${cmsImportType}`);
        }
        const customImportEnvVars = getCMSService().baseCustomImportEnvVars(project);
        result = Object.assign(result, customImportEnvVars);
    } else if (project.wizard?.cms?.id === 'contentful') {
        const contentfulSpaceId = project.getDeploymentData<string>('contentful.spaceId');
        const contentfulEnvironment = project.getDeploymentData<string>('contentful.environment', null, 'master');
        const contentfulPreviewApiKey = project.getDeploymentData<string>('contentful.previewApiKey');
        const contentfulAccessToken = project.getDeploymentData<string>('contentful.manageKey');
        result = Object.assign(result, {
            CONTENTFUL_SPACE_ID: contentfulSpaceId,
            CONTENTFUL_ENVIRONMENT: contentfulEnvironment,
            CONTENTFUL_PREVIEW_TOKEN: contentfulPreviewApiKey,
            // In Gatsby, CONTENTFUL_ACCESS_TOKEN is actually used for the preview key.
            // In all other cases we use CONTENTFUL_PREVIEW_TOKEN for the preview key.
            CONTENTFUL_ACCESS_TOKEN: project.wizard?.ssg?.id === 'gatsby' ? contentfulPreviewApiKey : contentfulAccessToken
        });
    } else if (project.wizard?.cms?.id === 'sanity') {
        const sanityAccessToken = project.getDeploymentData<string>('sanity.deployKey');
        const sanityProjectId = project.getDeploymentData<string>('sanity.projectId');
        const sanityDataset = project.getDeploymentData<string>('sanity.dataset', 'production');
        result = Object.assign(result, {
            SANITY_ACCESS_TOKEN: sanityAccessToken,
            SANITY_PROJECT_ID: sanityProjectId,
            SANITY_DATASET: sanityDataset,
        });
    } else if (project.wizard?.theme?.id === 'custom' &&
        project.wizard?.ssg?.id === 'hugo') {
        result = Object.assign(result, {
            HUGO_VERSION: '0.74.3'
        });
    }
    const existingUserEnv = project.getUserEnvironment();
    if (existingUserEnv) {
        result = Object.assign(result, existingUserEnv);
    }
    return result;
}

function getSsgOptions(project: IProjectDoc) {
    const ssgId = project.wizard?.ssg?.id;
    const themeId = project.wizard?.theme?.id;
    const result: any = {
        SSG_TYPE: ssgId
    };
    // isGeneric still needs to be checked for legacy projects
    if (themeId === 'custom' || project.wizard?.ssg?.settings?.isGeneric) {
        result['SSG_TYPE'] = 'generic';
        result['SSG_OPTIONS'] = {
            ssgName: ssgId
        };
        if (config.features.schemalessContainer) {
            result['ENABLE_SCHEMALESS'] = '1';
        }
        if (config.features.advancedContentLoaderContainer) {
            result['LOAD_ADVANCED_CONTENT'] = '1';
        }
    }

    const refreshCommand = project.getDeploymentData<string>('container.refreshCommand', null, '');
    if (refreshCommand) {
        _.set(result, 'SSG_OPTIONS.refreshCommand', refreshCommand);
    }

    const ssgRunnableDir = project.getDeploymentData<string>('container.runnableDir', null, '');
    if (ssgRunnableDir) {
        result['RUNNABLE_DIR'] = ssgRunnableDir;
    }
    return result;
}

async function handleGitPull(project: IProjectDoc, user: IUserDoc) {
    if (project.wizard?.cms?.id === 'forestry' &&
        project.getDeploymentData<string>('github.transferStatus') === 'transferred') {

        // forestry loses webhook functionality with transferred repos
        logger.debug('[shared-container] notifying Forestry', {projectId: project.id});
        const { previewBranch } = project.getContainerBranches();
        const forestryConnection = _.find(user.connections, { type: 'forestry' });
        const token = forestryConnection?.accessToken;
        try {
            return forestryService.reuploadSite(project, previewBranch, token);
        } catch (err) {
            logger.debug('[shared-container] Error reuploading Forestry site', { err, projectId: project.id });
        }
    }
}

function hasHMR(project: IProjectDoc) {
    return ['gatsby', 'nextjs'].includes(project.wizard?.ssg?.id ?? '');
}

function hasLiveReload(project: IProjectDoc) {
    return ['hugo', 'jekyll', 'eleventy', 'hexo', 'gridsome', 'nuxt', 'sapper', 'vuepress'].includes(project.wizard?.ssg?.id ?? '');
}

async function invalidateBranchStatusForBranch(project: IProjectDoc, branch: string) {
    const environments = projectUtils.getProjectEnvironments(project);
    return Promise.all(environments.map(async (environmentName) => {
        const { publishBranch, previewBranch } = project.getContainerBranches(environmentName);
        const isBranchMatches = branch === previewBranch || branch === publishBranch;

        if (previewBranch === publishBranch || !isBranchMatches) { // no need to check branch status for api based cms containers
            return;
        }

        return Project.updateDeploymentData(project._id!, 'container', { 'branchStatus.invalidate': true }, environmentName);
    }));
}

export function preDeploy(
    project: IProjectDoc,
    _user: IUserDoc,
    _buildLogger: winston.Logger,
    { previewBranch, publishBranch }: { previewBranch?: string, publishBranch?: string } = {}
) {
    const cmsId = _.get(project, 'wizard.cms.id');
    publishBranch = publishBranch || project.getDefaultBranch();
    previewBranch = previewBranch || _.get(project, `deploymentData.${cmsId}.branch`, publishBranch);

    return Project.updateDeploymentData(project._id!, 'container', { previewBranch, publishBranch });
}

export async function deploy(inProject: IProjectDoc, user: IUserDoc, buildLogger: winston.Logger) {
    let project: IProjectDoc | null = inProject;
    buildLogger.debug('[shared-container] Deploying shared container...');
    analytics.track('SharedContainer Project Preview Deploying', {
        projectId: project.id,
        userId: user.id,
    }, user);

    const projectName = projectUtils.uniqueAlphanumericName(project, project.name!);
    const envSubdomain = config.env === 'prod' ? '' : '.staging';
    const previewUrl = `https://preview--${projectName}${envSubdomain}.stackbit.dev`;
    const userEnv = getUserDefinedEnv(project);

    // TODO consolidate project updates
    const { privateKey, publicKey } = await generateKeys();
    project = await Project.updateDeploymentData(project._id!, 'container', {
        buildProgress: orchestrator.BuildStates.provisioningCms,
        status: orchestrator.ContainerStates.unknown,
        name: projectName,
        lastPreviewId: uuid(),
        url: previewUrl,
        internalUrl: previewUrl,
        hasHMR: hasHMR(project),
        hasLiveReload: hasLiveReload(project),
        deployPrivateKey: privateKey,
        deployPublicKey: publicKey,
        codeEditorKey: codeUtils.getRandomSecureString()
    });
    project = await Project.updateBuildStatus(project!._id!, 'deploying');
    project = await Project.updateUserEnvironment(project!._id!, userEnv);
    const continueDeploy = async (project: IProjectDoc) => {
        buildLogger.debug('[shared-container] Continuing deploy...');
        await Project.updateDeploymentData(project._id!, 'container', {
            buildProgress: orchestrator.BuildStates.initializing
        });
        let githubAccessToken = user.githubAccessToken;
        if (project.wizard?.repository?.settings?.sharedUser ?? true) {
            githubAccessToken = config.container.shared.githubAccessToken;
        }
        const allowWriteToRepo = !project?.wizard?.theme?.settings?.multisite;
        await repositoryTypes.callRepositoryMethodForProject('createDeployKey', project, {
            githubAccessToken: githubAccessToken
        }, project.getDeploymentData<string>('container.deployPublicKey'), 'Stackbit Deploy Key', allowWriteToRepo);
        buildLogger.debug('[shared-container] Creating container task...');
        return orchestrator.create(project, null, buildLogger);
    };

    const cmsId = _.get(project, 'wizard.cms.id');
    const provisioned = _.get(project, `deploymentData.${cmsId}.provisioned`, false);
    if (cmsId && !provisioned) {
        await getCMSService().baseInvokeContentSourcesWithProject('provision', project, user, async () => {
            buildLogger.debug('[shared-container] Provisioned drafts. Continuing deploy...');
            await continueDeploy(project!);
        }, async (progress: string) => {
            await Project.updateDeploymentData(project?._id!, 'container', {
                buildProgress: `${orchestrator.BuildStates.provisioningCms}/${progress}`
            });
        });
    } else {
        await continueDeploy(project!);
    }
    if (!project?.wizard?.deployment?.id) {
        // project doesn't has deployment service, no need to keep buildStatus as building, switch it to live immediately
        return Project.updateBuildStatus(project?._id!, 'live');
    }

    buildLogger.debug('[shared-container] Provisioned everything. Starting deploy...');
    return getDeploymentService().callPureDeploymentMethodForProject('deploy', project, user, buildLogger);
}

export async function onWebhook(project: IProjectDoc, user: IUserDoc | undefined, req: any, environmentName?: string | null) {
    try {
        const data = req.body;
        return orchestrator.webhookHandler(project, user, data, environmentName);
    } catch (err) {
        logger.error('Error shared container webhookHandler', {err, projectId: project.id, userId: user?.id });
    }
}

export function triggerAutoBuild(project: IProjectDoc, user: IUserDoc, payload: any) {
    const { buildType, action } = payload;
    const deploymentId = projectUtils.getDeploymentId(project);
    const branch = payload.branch;

    if (!buildType && action !== 'push') {
        return Promise.resolve(project);
    }
    logger.debug('[shared-container] pulling changes', {branch, buildType, action});
    const environmentName = branch === project.getDefaultBranch() ? null : branch;

    return Promise.all([
        (async () => { // Update
            try {
                if (buildType !== 'content-only') {
                    if (project.wizard?.cms?.id) {
                        await getCMSService().baseInvokeContentSourcesWithProject('pull', project, user, environmentName);
                    } else {
                        await containerService.pull(project, user);
                    }
                }
            } catch (err) {
                logger.warn('Error pulling from container', { err });
            }
            try {
                await invalidateBranchStatusForBranch(project, branch);
            } catch (err) {
                logger.warn('Error invalidating branch status for branch', { err, branch });
            }
        })(),
        (async () => { // Trigger build
            try {
                const hasBuildHook = project.getDeploymentData(`${deploymentId}.buildHookUrl`, environmentName);
                const buildHookEnabled = project.getDeploymentData(`${deploymentId}.buildHookEnabled`, environmentName);
                logger.debug('[shared-container] trigger build', {branch, buildType, action, hasBuildHook, buildHookEnabled});
                if (branch && branch.startsWith('preview')) {
                    logger.debug('[shared-container] handle git pull');
                    await handleGitPull(project, user);
                } else if ((branch && hasBuildHook) || buildType || buildHookEnabled) {
                    logger.debug('[shared-container] triggering auto build');
                    await getDeploymentService().callPureDeploymentMethodForProject('triggerAutoBuild', project, user, payload);
                }
            } catch (err) {
                logger.error('Error triggering autoBuild', { err });
            }
        })()
    ]);
}

export async function destroy(project: IProjectDoc, user: IUserDoc, buildLogger: winston.Logger) {
    buildLogger.debug('[shared-container] delete triggered', { projectId: project.id });
    await orchestrator.deleteContainer(project, user, null, buildLogger);
    await environmentsService.removeAllEnvironments(project, user);
    return getSplitService().cleanupSplitTest(project, user);
}

export async function redeploy(
    project: IProjectDoc,
    _user: IUserDoc,
    _environmentName: string | null | undefined,
    buildLogger: winston.Logger,
    { force }: { force?: boolean } = { }
) {
    if (force) {
        return orchestrator.upgrade(project, buildLogger);
    } else {
        return orchestrator.upgradeIfNeeded(project, buildLogger);
    }
}

export async function createAPIKey(project: IProjectDoc, user: IUserDoc) {
    project = (await Project.createAPIKey(project._id!, 'container-key'))!;
    //TODO in the future, not all projects will require a netlify deployment
    project = await getDeploymentService().callPureDeploymentMethodForProject('createAPIKey', project, user);
    return project;
}

export async function buildProject(project: IProjectDoc, user: IUserDoc, buildLogger: winston.Logger) {
    buildLogger.debug('[shared-container] building project', {projectId: project.id});

    if (projectUtils.isV2Supported(project) && project._id) {
        const deploymentId = project?.wizard?.deployment?.id;
        _.set(project, `deploymentData.${deploymentId}.contactFormSecret`, uuid());
    }



    if (project.wizard?.repository?.settings?.sharedUser?.true) {
        _.set(project, 'wizard.repository.settings.privateRepo', false);
    }

    project = (await Project.updateProject(project._id!, project, user._id!))!;

    buildLogger.debug('running factory');
    try {
        project = (await getFactoryService().buildProject(project, user, buildLogger))!;
        if (!project.settings.hasStackbitPull && project.wizard?.ssg?.id !== 'nextjs') {
            return project;
        }

        await getCMSService().baseInvokeContentSourcesWithProject('preProvision', project, user, buildLogger);
        return project;
    } catch (err) {
        buildLogger.error('[shared-container] error building project', {error: err});
        throw ResponseErrors.StackbitFactoryBuildError;
    }
}

export function updateProjectData(project: IProjectDoc, user: IUserDoc) {
    return getDeploymentService().callPureDeploymentMethodForProject('updateProjectData', project, user);
}

export async function updateProjectDeploymentData(project: IProjectDoc, user: IUserDoc, params: any) {
    let environmentPromises: Promise<void>[] = [];

    if (project.buildStatus !== 'draft' && project.deploymentData?.container) {
        const environments = projectUtils.getProjectEnvironments(project);
        environmentPromises = environments.map(async (environmentName) => {
            const isContainerRunning = [orchestrator.ContainerStates.running, orchestrator.ContainerStates.restarting].includes(project?.deploymentData?.container?.status);

            if (!isContainerRunning) {
                return Promise.resolve();
            }

            const previousBranchStatus = project.getDeploymentData<Record<string, unknown>>('container.branchStatus', environmentName);
            if (!previousBranchStatus || previousBranchStatus.invalidate) {
                const { previewBranch, publishBranch } = project.getContainerBranches(environmentName);

                if (previewBranch !== publishBranch) {
                    let { githubAccessToken } = user;
                    if (project.wizard?.repository?.settings?.sharedUser) {
                        githubAccessToken = config.container.shared.githubAccessToken;
                    }
                    let branchStatus: any | undefined;
                    try {
                        branchStatus = await gitRepo.compareBranches({
                            project,
                            token: githubAccessToken,
                            base: publishBranch,
                            head: previewBranch
                        });
                    } catch (err) {
                        if ((err as any)?.code >= 400 && (err as any)?.code < 500) {
                            logger.warn('Error getting branch status from github, requesting from container', { err, projectId: project.id });
                            return containerService.getBranchStatus(project, user, environmentName); // returns { ahead, behind } already
                        }
                        throw err;
                    }
                    try {
                        if (branchStatus.behind > 0) {
                            const { canPublish } = await containerService.canPublish(project, user, environmentName);
                            branchStatus.canPublish = canPublish;
                        }
                    } catch (err) {
                        logger.error('Error getting branch status when updating master preview changes', { err, projectId: project.id, previewBranch, publishBranch });
                    }
                    await Project.updateDeploymentData(project._id!, 'container', { branchStatus }, environmentName);
                } else {
                    await Project.updateDeploymentData(project._id!, 'container', { branchStatus: {} }, environmentName);
                }
            }
        });
    }
    if (params?.updateHealth) {
        const environments = projectUtils.getProjectEnvironments(project);
        await Promise.all(environments.map(async (environmentName) => {
            return orchestrator.checkHealth(project, user, environmentName);
        }));
    }

    await Promise.all(environmentPromises);
    return getDeploymentService().callPureDeploymentMethodForProject('updateProjectDeploymentData', project, user, params);
}

export async function triggerBuild(project: IProjectDoc, user: IUserDoc, payload: any) {
    return getDeploymentService().callPureDeploymentMethodForProject('triggerBuild', project, user, payload);
}

export async function getLogs(project: IProjectDoc, nextToken: string | undefined, environmentName: string | null | undefined) {
    const service = getProjectPreviewContainerService(project);
    const taskHandle = project.getDeploymentData(`container.${service.taskHandleKey}`, environmentName) ||
        project.getDeploymentData(`container.${service.newTaskHandleKey}`, environmentName) ||
        project.getDeploymentData(`container.${service.prevTaskHandleKey}`, environmentName);
    if (!taskHandle) {
        throw ResponseErrors.LogsNotAvailable;
    }
    // don't request logs older than 7 days
    const minStartDate = new Date((new Date()).getTime() - (7 * 24 * 60 * 60 * 1000));
    let startDate = project.createdAt;
    if (!startDate || startDate < minStartDate) {
        startDate = minStartDate;
    }
    return service.getLogs(taskHandle, nextToken, startDate);
}

export async function getHealth(project: IProjectDoc, user: IUserDoc, environmentName: string | null | undefined, warmup: boolean) {
    return orchestrator.checkHealth(project, user, environmentName, warmup);
}

export function refreshContent(project: IProjectDoc, user: IUserDoc) {
    return Promise.all(projectUtils.getProjectEnvironments(project).map(async (environmentName) => {
        await containerService.refresh(project, user, environmentName);
    }));
}

export function refreshSchema(project: IProjectDoc, user: IUserDoc, { branch }: { branch?: string } = {}) {
    const environmentName = branch === project.getDefaultBranch() ? null : branch;
    logger.debug('[shared-container] refreshing schema', { projectId: project.id, environmentName, branch });
    return containerService.refreshSchema(project, user, environmentName);
}

export async function setDeploymentBuildProgress(project: IProjectDoc, ...args: any[]) {
    return getDeploymentService().callPureDeploymentMethodForProject('setDeploymentBuildProgress', project, ...args);
}

export async function getEnvironmentVariables(project: IProjectDoc, user: IUserDoc, environmentName?: string | null): Promise<Record<string, any>> {
    const { previewBranch, publishBranch } = project.getContainerBranches(environmentName);
    const ssgOptions = getSsgOptions(project);
    const userEnv = project.getDeploymentData('container.env', environmentName);
    const deploymentOptions = (project.wizard?.deployment?.id === 'netlify' && user.netlifyAccessToken)
        ? { NETLIFY_ACCESS_TOKEN: user.netlifyAccessToken }
        : {};
    const cmsEnvForContainer = project.wizard?.cms?.id
        ? await require('../cmss').baseInvokeContentSourcesWithProject('envForContainer', project, user, environmentName)
        : {};
    return _.merge({
        CONFIG_ENV: config.container.env,
        CONTAINER_NAME: project.getDeploymentData('container.name', environmentName, project.name),
        STACKBIT_PROJECT_ID: project.id,
        STACKBIT_API_URL: config.server.webhookHostname,
        STACKBIT_API_SECRET: project.APIKeys?.find(key => key.name === 'container-key')?.key,
        CODE_EDITOR_KEY: project.getDeploymentData('container.codeEditorKey', environmentName),
        REPO_URL: project.getDeploymentData<string>('container.repoUrl', environmentName) ?? project.getDeploymentData<string>('github.sshURL', environmentName),
        REPO_PRIVATE_KEY: project.getDeploymentData<string>('container.deployPrivateKey', environmentName),
        REPO_COMMIT: project.getDeploymentData<string>('container.themeCommitHash', environmentName),
        WEBHOOK_URL: `${config.server.webhookHostname}/project/${project.id}/webhook/container/${environmentName || ''}`,
        REPO_BRANCH: previewBranch,
        REPO_PUBLISH_BRANCH: publishBranch,
        STACKBIT_USER_VARS: userEnv
    }, ssgOptions, cmsEnvForContainer || {}, deploymentOptions, _.get(project, 'settings.hasStackbitPull') ? {
        HAS_STACKBIT_PULL: '1'
    } : {}, project.getDeploymentData('container.hasFastWrite', environmentName) ? {
        FAST_WRITE: '1'
    } : {}, project.getDeploymentData('container.stackbitYaml', environmentName) ? {
        STACKBIT_YAML: project.getDeploymentData('container.stackbitYaml', environmentName)
    } : {}, config.container.snippetUrl ? {
        SNIPPET_URL: config.container.snippetUrl
    } : {}, _.get(project, 'wizard.settings.isAnnotationBased') ? {
        ANNOTATION_BASED: '1'
    } : {}, project.getDeploymentData('container.containerEnv', environmentName, {}));
}
