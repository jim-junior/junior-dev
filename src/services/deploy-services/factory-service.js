const {spawn} = require('child_process');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const PATH_TO_GENERATED = path.join(__dirname, '../../../data/gen/');
const config = require('../../config').default;
const _ = require('lodash');
const Project = require('../../models/project.model').default;
const ResponseErrors = require('../../routers/response-errors');
const logger = require('../../services/logger');
const os = require('os');
const uuid = require('uuid/v4');
const yaml = require('js-yaml');
const factoryProvider = require('@stackbit/stackbit-factory-provider');
const customThemeConverter = require('./theme-converter-service');
const projectUtils = require('../../services/project-services/project-utils').default;

module.exports = {
    buildProject,
    cloneTheme,
    cleanupTheme,
    provision,
    getStackbitYamlFromProjectInfo,
    PATH_TO_GENERATED
};

// A temporary workaround for cyclic dependencies between deployment and other services
function getCMSService() {
    return require('./cmss');
}

const gitService = require('./git-service');
const rimraf = require('rimraf');
const { authorizedThemeUrl, sourceInputTheme, hasHandcraftedNextjsTheme } = require('./theme-services');

function buildProject(project, user, buildLogger) {
    if (!_.get(project, 'wizard.theme.id') || !_.get(project, 'wizard.ssg.id')) {
        const missingParams = ['theme', 'ssg'].filter(item => !_.get(project, `wizard.${item}.id`)).join(', ');
        throw {
            message: `Stackbit Factory: Missing parameters: ${missingParams}`
        };
    }

    return Promise.resolve(project).then(project => {
        return sourceInputTheme(project, user, buildLogger).then(({repoPath, hash}) => {
            return {repoPath, hash, project};
        });
    }).then(async ({repoPath, hash, project}) => {
        const outputDir = PATH_TO_GENERATED + project.id + '/output';

        const isCustomTheme = _.get(project, 'wizard.theme.id') === 'custom';
        const stackbitYmlFound = _.get(project, 'wizard.theme.settings.stackbitYmlFound');
        const stackbitYmlValid = _.get(project, 'wizard.theme.settings.stackbitYmlValid');
        const unibitTheme = _.get(project, 'wizard.theme.settings.themeConfig.ssgName') === 'unibit';
        const hasImport = _.get(project, 'wizard.theme.settings.themeConfig.import');
        const cmsId = _.get(project, 'wizard.cms.id');

        if (hasImport) {
            buildLogger.debug('Spawn Import');
            await spawnImportCommand(project, user, repoPath, outputDir, buildLogger);
            project = await Project.updateDeploymentData(project.id, cmsId, { provisioned: true });
        } else if ((isCustomTheme && !unibitTheme) || hasHandcraftedNextjsTheme(project)) {
            buildLogger.debug('Spawn Custom Theme Convert');
            await customThemeConverter.convert(project, repoPath, outputDir, buildLogger);
        } else {
            buildLogger.debug('Spawn Factory Convert');
            if (projectNeedsStackbitPull(project)) {
                project = await Project.updateProject(project.id, {'settings.hasStackbitPull': true}, user.id);
            }
            const cmdArgs = [
                ...getBasicCmdArgsForProject(project, user, repoPath, outputDir, buildLogger),
                ...getCMSCmdArgsForProject(project, user, buildLogger)
            ];
            buildLogger.debug('Generating site files', cmdArgs);
            await spawnConvert(cmdArgs, buildLogger);
            if (!cmdArgs.includes('--cms-dry-run')) {
                // if '--cms-dry-run' not included, factory takes care of provisioning the CMS
                project = await Project.updateDeploymentData(project.id, cmsId, { provisioned: true });
            }
        }

        return Project.updateDeploymentData(project._id, 'build', {
            themeHash: hash,
            outputDir: outputDir,
            rmdir: PATH_TO_GENERATED + project.id
        });
    }).catch(err => {
        _.set(project, 'deploymentData.build.rmdir', PATH_TO_GENERATED + project.id);
        throw err;
    });
}

async function spawnImportCommand(project, user, inputDir, outputDir, buildLogger) {
    const cmsImportType = _.get(project, 'wizard.theme.settings.themeConfig.import.type');
    if (!['contentful', 'sanity'].includes(cmsImportType)) {
        throw new Error(`CMS Import Error: import.type not supported: ${cmsImportType}`);
    }
    await getCMSService().baseInvokeContentSourcesWithProject('customImport', project, user, inputDir, buildLogger);
    await fse.copy(inputDir, outputDir);
}

function spawnConvert(cmdArgs, buildLogger) {
    const buildCmd = spawn(require.resolve('@stackbit/stackbit-factory-provider/convert.js'), cmdArgs, {shell: true});
    const errors = [];

    return new Promise((resolve, reject) => {
        buildCmd.stdout.on('data', (data) => {
            buildLogger.debug(`Factory: ${data.toString().trim()}`);
        });

        buildCmd.stderr.on('data', (data) => {
            buildLogger.error(`Factory Error: ${data.toString().trim()}`);
            errors.push(data.toString());
        });

        buildCmd.on('exit', code => {
            if (code === 0) {
                return resolve();
            }

            let err = ResponseErrors.StackbitFactoryBuildError;
            err.message = `Stackbit Factory Build Error: ${errors.join('')}`;
            reject(err);
        });
    });
}

function getBasicCmdArgsForProject(project, user, inputDir, outputDir, buildLogger) {
    const hostname = config.env === 'local' ? config.server.webhookHostname : config.server.hostname;
    const cmdArgs = [
        '-s', _.get(project, 'wizard.ssg.id'),
        '-i', inputDir,
        '-o', outputDir,
        `--install-folder=${path.join(__dirname, '../../..', config.stackbitFactory.installFolder)}`,
        `--local-path=${path.join(__dirname, '../../..', config.stackbitFactory.localPath)}`,
        `--stackbit-webhook-url=${hostname}/project/${project.id}/webhook/build`,
        `--stackbit-project-name="${projectUtils.alphanumericName(project.name)}"`,
        `--stackbit-project-id=${project.id}`,
        `--deployment-type=${_.get(project, 'wizard.deployment.id', 'netlify')}`
    ];

    const themeUrl = _.get(project, 'wizard.theme.settings.source');

    if (themeUrl) {
        cmdArgs.push(`--stackbit-theme-url=${themeUrl}`);
    }

    if (config.stackbitFactory.useLocal) {
        cmdArgs.push('--use-local');
    }
    if (config.stackbitFactory.includePrerelease) {
        cmdArgs.push('--include-prerelease');
        if (config.stackbitFactory.prereleaseTags) {
            cmdArgs.push('--prerelease-tags', ...config.stackbitFactory.prereleaseTags);
        }
    }

    if (_.get(project, 'settings.hasStackbitPull')) {
        if (!['sanity', 'contentful', 'datocms'].includes(_.get(project, 'wizard.cms.id'))) {
            buildLogger.debug('Build: adding serverless build api url');
            const apiUrl = `${hostname}/pull/${project._id}`;
            cmdArgs.push('--stackbit-pull-api-url=' + apiUrl);
        }
    }

    if (_.get(project, 'wizard.settings.enableWidget')) {
        buildLogger.debug('Build: adding stackbit widget');
        cmdArgs.push('--stackbit-widget-url=' + config.build.stackbitWidget.widgetUrl);
    }

    if (_.get(project, 'importData.dataContextPath')) {
        cmdArgs.push('--preprocess-context=' + _.get(project, 'importData.dataContextPath'));
    }

    // shared container deployment handles CMS provisioning
    if (_.get(project, 'wizard.container.id') === 'sharedContainer') {
        cmdArgs.push('--cms-dry-run');
    }

    return cmdArgs;
}

function projectNeedsStackbitPull(project) {
    const ssgId = _.get(project, 'wizard.ssg.id');
    const cmsId = _.get(project, 'wizard.cms.id');

    // git-cms never needs stackbit-pull, all SSGs read the content directly from filesystem
    if (['nocms', 'git'].includes(cmsId)) {
        return false;
    }

    const cntfl = 'contentful';
    const santy = 'sanity';
    const dato = 'datocms';
    const devto = 'devto';

    // devto always fetched with stackbit-pull, no sourcebit or gatsby plugin for devto
    // datocms always fetched with stackbit-pull, no sourcebit plugin for datocms, TODO: use gatsby plugin
    // nextjs has sourcebit plugins for contentul and sanity, TODO: for datocms and devto use stackbit-pull + sourcebit-source-filesystem
    const stackbitPullMatrix = {
        '_cms_':  [cntfl, santy, dato,  devto],
        'nextjs': [false, false, true,  true],
        'gatsby': [true,  true,  true,  true],
        'hugo':   [true,  true,  true,  true],
        'jekyll': [true,  true,  true,  true]
    };

    const cmsColIdx = stackbitPullMatrix._cms_.indexOf(cmsId);
    if (cmsColIdx === -1) {
        return false;
    }
    const ssgRow = _.get(stackbitPullMatrix, ssgId);
    if (!ssgRow) {
        return false;
    }

    return ssgRow[cmsColIdx];
}

function getCMSCmdArgsForProject(project, user, buildLogger) {
    let cmdArgs = [];
    const cmsId = _.get(project, 'wizard.cms.id');

    if (cmsId !== 'nocms' &&
        cmsId !== 'devto' &&
        cmsId !== 'git') {

        cmdArgs.push('-c');
        cmdArgs.push(cmsId);

        cmdArgs.push(...getCMSService().baseContextForBuild(project, user, buildLogger));
    }

    return cmdArgs;
}

function cloneTheme(user, repoUrl, branch, cloneOptions) {
    const cloneUrl = authorizedThemeUrl(repoUrl, user);
    const clonePath = path.join(os.tmpdir(), uuid());

    logger.debug('Clonning theme', { cloneUrl });

    return gitService.cloneRepo(clonePath, cloneUrl, logger, { branch, cloneOptions })
        .catch(() => { throw ResponseErrors.GithubSourceRepoNotFound; })
        .then(() => {
            logger.debug('Done cloning');
            return clonePath;
        });
}

function cleanupTheme(inputDir) {
    return new Promise((resolve, reject) => {
        rimraf(inputDir, (rimrafErr) => {
            if (rimrafErr) {
                return reject(rimrafErr);
            }
            resolve();
        });
    }).catch((err) => {
        throw ResponseErrors.ErrorWithDebug('ThemeCleanupFailed', err);
    });
}

async function provision(inputDir, context) {
    const stackbitYaml = await getStackbitYaml(inputDir);
    const themeVersion = _.get(stackbitYaml, 'stackbitVersion');
    return factoryProvider(themeVersion, {
        installFolder: path.join(__dirname, '../../..', config.stackbitFactory.installFolder),
        useLocal: config.stackbitFactory.useLocal,
        localPath: path.join(__dirname, '../../..', config.stackbitFactory.localPath),
        includePrerelease: config.stackbitFactory.includePrerelease,
        prereleaseTags: config.stackbitFactory.prereleaseTags
    }).then(({factory}) => {
        return factory.provision(context);
    });
}

async function getStackbitYamlFromProjectInfo(project) {
    return getStackbitYaml(_.get(project, 'deploymentData.build.outputDir'));
}

async function getStackbitYaml(repoDir) {
    const stackbitYamlFilePath = path.join(repoDir, 'stackbit.yaml');
    const stackbitYamlData = await fse.readFile(stackbitYamlFilePath);
    return yaml.safeLoad(stackbitYamlData);
}
