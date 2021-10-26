const _ = require('lodash');
const fse = require('fs-extra');
const path = require('path');
const toml = require('@iarna/toml');
const yaml = require('js-yaml');
const { convertToYamlConfig } = require('@stackbit/sdk');

const gitService = require('./git-service');
const { gemfileContainsGem, gemfileContainsGemspec } = require('./repo-analyzer-service');

module.exports = {
    convert
};

const SSG_BUILD_CONFIG = {
    hugo: { command: 'hugo', publish: 'public' },
    jekyll: { command: 'jekyll build', publish: '_site' },
    gatsby: { command: 'gatsby build', publish: 'public' },
    eleventy: { command: 'eleventy', publish: '_site' },
    gridsome: { command: 'gridsome build', publish: 'dist' },
    nextjs: { command: 'npm run build && npm run export', publish: 'out' },
    hexo: { command: 'hexo generate', publish: 'public' },
    nuxt: { command: 'nuxt build', publish: 'dist' },
    vuepress: { command: 'vuepress build', publish: '.vuepress/dist/' },
    sapper: { command: 'sapper export', publish: '__sapper__/export' }
};

const DEFAULT_GEMFILE = `
source 'https://rubygems.org'

gem 'jekyll'`;

const getDefaultConfigToml = (themeName) => `
theme = "${themeName}"
themesDir = "themes"`;

async function removePrefixFromFile(fileName, prefixes) {
    const pathExists = await fse.pathExists(fileName);
    if (!pathExists) {
        return;
    }
    const data = await fse.readFile(fileName);
    let filteredData = data.toString();
    prefixes.forEach(prefix => {
        filteredData = filteredData.replace(new RegExp(`^${prefix}.*\n?`, 'gm'), '').trim();
    });
    await fse.writeFile(fileName, filteredData);
}

async function createNetlifyTomlIfNeeded(dir, ssg) {
    const buildConfig = SSG_BUILD_CONFIG[ssg];
    if (!buildConfig) {
        return;
    }
    const fileName = path.join(dir, 'netlify.toml');
    const pathExists = await fse.pathExists(fileName);
    if (pathExists) {
        return;
    }
    const data = toml.stringify({
        build: buildConfig
    });
    await fse.writeFile(fileName, data);
}

async function generateStackbitYml(outputDir, config, logger) {
    try {
        const yamlConfig = convertToYamlConfig({config});
        const fileName = path.join(outputDir, 'stackbit.yaml');
        const data = yaml.dump(yamlConfig);
        await fse.writeFile(fileName, data);
    } catch (err) {
        logger.error('Error generating stackbit.yaml for custom theme', {err});
    }
}

async function convertJekyll(sourceDir, outputDir, logger) {
    logger.debug('[theme-converter] copying dir contents...');
    await fse.copy(sourceDir, outputDir);

    const gemfilePath = path.join(outputDir, 'Gemfile');
    const gemfileExists = await fse.pathExists(gemfilePath);

    if (gemfileExists) {
        let gemfileData = (await fse.readFile(gemfilePath)).toString();
        if (gemfileContainsGem(gemfileData, 'jekyll') || gemfileContainsGem(gemfileData, 'github-pages')) {
            logger.debug('[theme-converter] Gemfile contains gem jekyll or github-pages');
        } else if (gemfileContainsGemspec(gemfileData)) {
            logger.debug('[theme-converter] Gemfile contains gemspec');
        } else {
            if (!gemfileData.match(/^source/gm)) {
                gemfileData = 'source \'https://rubygems.org\'\n' + gemfileData;
            }
            const sourceMatch = gemfileData.match(/source.*\n/);
            if (sourceMatch) {
                const jekyllGemData = '\ngem \'jekyll\'\n';
                const insertAtIndex = sourceMatch.index + sourceMatch[0].length;
                gemfileData = gemfileData.slice(0, insertAtIndex) + jekyllGemData + gemfileData.slice(insertAtIndex);
            }
            logger.debug('[theme-converter] adding jekyll to Gemfile');
            await fse.writeFile(gemfilePath, gemfileData);
        }
    } else {
        logger.debug('[theme-converter] creating Gemfile');
        await fse.writeFile(gemfilePath, DEFAULT_GEMFILE);
    }

    let additionalGems = [];
    const configPath = await getConfigFilePath(outputDir, ['_config.toml', '_config.yml']);
    if (!_.isEmpty(configPath)) {
        logger.debug('[theme-converter] updating config');
        const configData = await fse.readFile(configPath);
        let config = parseDataByFilePath(configData, configPath);
        config.baseurl = '';
        config.url = '';
        await fse.writeFile(configPath, stringifyDataByFilePath(config, configPath));
        additionalGems = _.compact(_.concat(config.plugins, config.gems));
    }

    if (!_.isEmpty(additionalGems)) {
        let gemfileData = (await fse.readFile(gemfilePath)).toString();
        // at this point we expect to find a gem in the Gemfile
        const insertAtIndex = gemfileData.indexOf('\ngem ');
        if (insertAtIndex >= 0) {
            logger.debug('[theme-converter] adding additional gems');
            const additionalGemsString = '\n' + additionalGems.filter(gem => !gemfileData.includes(gem)).map(gem => `gem '${gem}'`).join('\n') + '\n';
            gemfileData = gemfileData.slice(0, insertAtIndex) + additionalGemsString + gemfileData.slice(insertAtIndex);
            await fse.writeFile(gemfilePath, gemfileData);
        }
    }
}

async function getConfigFilePath(dir, configFiles) {
    for (const configFile of configFiles) {
        const configPath = path.join(dir, configFile);
        const configExists = await fse.pathExists(configPath);
        if (configExists) {
            return configPath;
        }
    }
    return null;
}

async function convertHugo(sourceDir, outputDir, logger) {
    // if we can find a config there's nothing to do
    const hugoConfigs = ['config.toml', 'config.json', 'config.yaml', 'config.yml'];
    const configPath = await getConfigFilePath(sourceDir, hugoConfigs);
    if (!_.isEmpty(configPath)) {
        logger.debug('[theme-converter] found config. copying dir contents as-is...');
        return fse.copy(sourceDir, outputDir);
    }

    // no config found, search for theme.toml and exampleSite
    const exampleSitePath = path.join(sourceDir, 'exampleSite');
    const exampleSiteExists = await fse.pathExists(exampleSitePath);
    const themeConfigPath = path.join(sourceDir, 'theme.toml');
    const themeConfigExists = await fse.pathExists(themeConfigPath);
    const stackbitYmlPath = path.join(sourceDir, 'stackbit.yaml');
    const stackbitYmlExists = await fse.pathExists(stackbitYmlPath);
    if (themeConfigExists && exampleSiteExists) {
        await fse.copy(exampleSitePath, outputDir);

        const themeConfigData = await fse.readFile(themeConfigPath);
        let themeConfig = {};
        try {
            themeConfig = toml.parse(themeConfigData);
        } catch (err) {
            logger.error('[theme-converter] Error parsing theme.toml', {err});
        }
        const themeName = _.get(themeConfig, 'name', 'theme').toLowerCase();

        const themePath = path.join(outputDir, 'themes', themeName);
        await fse.ensureDir(themePath);
        await fse.copy(sourceDir, themePath);

        await removePrefixFromFile(path.join(outputDir, '.gitignore'), ['/themes', 'themes']);

        const configPath = await getConfigFilePath(outputDir, hugoConfigs);
        if (_.isEmpty(configPath)) {
            logger.debug('[theme-converter] creating default hugo config');
            await fse.writeFile(path.join(outputDir, 'config.toml'), getDefaultConfigToml(themeName));
        } else {
            logger.debug('[theme-converter] amending hugo config');
            const configData = await fse.readFile(configPath);
            let config = parseDataByFilePath(configData, configPath);
            config = _.assign(_.omit(config, ['Theme', 'ThemesDir', 'BaseURL', 'PublishDir']), {
                theme: themeName,
                themesDir: 'themes',
                baseURL: '',
                publishDir: 'public'
            });
            await fse.writeFile(configPath, stringifyDataByFilePath(config, configPath));
        }

        if (stackbitYmlExists) {
            await fse.copy(stackbitYmlPath, path.join(outputDir, 'stackbit.yaml'));
        }
    } else {
        throw new Error('Missing structure needed to create site');
    }
}


function parseDataByFilePath(string, filePath) {
    const extension = path.extname(filePath).substring(1);
    let data;
    switch (extension) {
    case 'yml':
    case 'yaml':
        data = yaml.safeLoad(string, {json: true});
        break;
    case 'json':
        data = JSON.parse(string);
        break;
    case 'toml':
        data = toml.parse(string);
        break;
    }
    return data;
}

function stringifyDataByFilePath(data, filePath) {
    const extension = path.extname(filePath).substring(1);
    let result;
    switch (extension) {
    case 'yml':
    case 'yaml':
        result = yaml.safeDump(data, {noRefs: true});
        break;
    case 'json':
        result = JSON.stringify(data, null, 4);
        break;
    case 'toml':
        result = toml.stringify(data);
        break;
    }
    return result;
}

async function convert(project, sourceDir, outputDir, buildLogger) {
    const ssgId = _.get(project, 'wizard.ssg.id');
    try {
        if (ssgId === 'jekyll') {
            buildLogger.debug('[theme-converter] convert jekyll');
            await convertJekyll(sourceDir, outputDir, buildLogger);
        } else if (ssgId === 'hugo') {
            buildLogger.debug('[theme-converter] convert hugo');
            await convertHugo(sourceDir, outputDir, buildLogger);
        } else {
            buildLogger.debug('[theme-converter] no conversion needed, copying as-is');
            await fse.ensureDir(outputDir);
            await fse.copy(sourceDir, outputDir);
        }
    } catch (err) {
        buildLogger.error('Error converting theme', {err});
        const outputExists = await fse.pathExists(outputDir);
        if (!outputExists) {
            await fse.copy(sourceDir, outputDir);
        }
    } finally {
        await createNetlifyTomlIfNeeded(outputDir, ssgId);
        await gitService.removeWorkflows(outputDir);
    }
    const stackbitYmlFound = _.get(project, 'wizard.theme.settings.stackbitYmlFound');
    const themeConfig = _.get(project, 'wizard.theme.settings.themeConfig');
    if (!stackbitYmlFound && themeConfig) {
        await generateStackbitYml(outputDir, themeConfig, buildLogger);
    }
}
