import _ from 'lodash';
import { readFile } from 'fs-extra';
import { join } from 'path';
import {
    FileSystemFileBrowserAdapter,
    FileBrowser,
    analyzeSite,
    loadConfig,
    loadContent,
    ConfigError,
    ContentLoaderResult,
    Config,
    CMSMatchResult,
    SSGMatchResult
} from '@stackbit/sdk';
import { IUserDoc } from '../../models/user.model';
import logger from '../../services/logger';
import analytics from '../../services/analytics/analytics';
import { fetchBranches, fetchDefaultBranch } from '../github-services/github-repo';
import { decodeRepoUrl, getUserOrPublicGithubToken } from '../github-services/github-utils';
import { cloneTheme, cleanupTheme } from '../deploy-services/factory-service';

type IResultConfig = Config | null;

interface IValidation {
    config?: ConfigError[];
    content?: ContentLoaderResult['errors'];
    hasConfig: boolean;
}

interface ISiteResult {
    validation: IValidation;
    config?: IResultConfig;
    cmsMatchResult?: Partial<Pick<CMSMatchResult, 'cmsName' | 'cmsData'>>;
    ssgMatchResult?: Partial<Pick<SSGMatchResult, 'ssgName' | 'ssgDir' | 'envVars'>>;
    invalidBranch?: string;
}

type IAnalyzeSiteStackResult = Pick<ISiteResult, 'invalidBranch' | 'validation' | 'config'> & ISiteResult['cmsMatchResult'] & ISiteResult['ssgMatchResult'];

interface IBranches {
    branches: [string] | [];
}

interface IBranch {
    branch: string;
    name?: string;
}

interface IPackageJson {
    name?: string;
}

type IAnalyzeResult = IAnalyzeSiteStackResult & IBranches & IBranch;

const getStackbitYamlValidationAnalyticsData = ({
    packageJson,
    stackbitYamlFile
}: {
    packageJson: IPackageJson;
    stackbitYamlFile: IResultConfig;
}) => {
    const stackbitYamlFound = Boolean(stackbitYamlFile);

    return {
        stackbitYamlFound,
        isTutorialRepo: isTutorialRepo(packageJson)
    };
};

const isTutorialRepo = (packageJson: IPackageJson) => packageJson?.name === 'gatsby-starter-blog';

const analyzeSiteFromExistingConfig = async ({
    repoPath,
    validateContent
}: {
    repoPath: string;
    validateContent: boolean;
}): Promise<ISiteResult> => {
    let siteResult = {};
    const configResult = await loadConfig({
        dirPath: repoPath
    });

    const validation: IValidation = {
        hasConfig: Boolean(configResult.config)
    };

    if (configResult.errors && validateContent) {
        validation.config = configResult.errors;
    }

    if (configResult.config) {
        siteResult = {
            config: configResult.config,
            cmsMatchResult: {
                cmsName: configResult.config.cmsName
            },
            ssgMatchResult: {
                ssgName: configResult.config.ssgName
            }
        };

        if (validateContent) {
            const result = await loadContent({ dirPath: repoPath, config: configResult.config, skipUnmodeledContent: true });

            if (result.errors) {
                validation.content = result.errors.map((error) => ({
                    ...error,
                    message: error.message
                }));
            }
        }
    }

    return {
        ...siteResult,
        validation
    };
};

const analyzeSiteStack = async ({
    user,
    repoPath,
    validateContent,
    initializer
}: {
    user: IUserDoc;
    repoPath: string;
    validateContent: boolean;
    initializer: string;
}): Promise<IAnalyzeSiteStackResult> => {
    const fileBrowserAdapter = new FileSystemFileBrowserAdapter({ dirPath: repoPath });
    const fileBrowser = new FileBrowser({ fileBrowserAdapter });
    const analyzeSiteResult = await Promise.allSettled([
        analyzeSiteFromExistingConfig({ repoPath, validateContent }).then(
            ({ ssgMatchResult, cmsMatchResult, config, validation }): IAnalyzeSiteStackResult => ({
                ssgName: ssgMatchResult?.ssgName,
                ssgDir: ssgMatchResult?.ssgDir,
                envVars: ssgMatchResult?.envVars,
                cmsName: cmsMatchResult?.cmsName,
                cmsData: cmsMatchResult?.cmsData,
                config,
                validation
            })
        ),
        analyzeSite({ fileBrowser }).then(
            ({ ssgMatchResult, cmsMatchResult, config }): IAnalyzeSiteStackResult => ({
                ssgName: ssgMatchResult?.ssgName,
                ssgDir: ssgMatchResult?.ssgDir,
                envVars: ssgMatchResult?.envVars,
                cmsName: cmsMatchResult?.cmsName,
                cmsData: cmsMatchResult?.cmsData,
                config,
                validation: {
                    // analyzeSite always generate new config file, hence it can't have config
                    hasConfig: false
                }
            })
        )
    ]);

    let analyticsMessage = '';

    if (_.every(analyzeSiteResult, { status: 'fulfilled' })) {
        analyticsMessage = 'Analyze Site Done';
    } else if (_.every(analyzeSiteResult, { status: 'rejected' })) {
        analyticsMessage = 'Analyze Site Failed';
    } else {
        analyticsMessage = 'Analyze Site Done With Errors';
    }

    const [siteResultWithExistingConfig, siteResult] = analyzeSiteResult;

    const defaultResult: { config: Config | null; validation: IValidation } = {
        config: null,
        validation: {
            hasConfig: false
        }
    };

    const result = Object.assign(
        defaultResult,
        siteResult.status === 'fulfilled' ? _.omitBy(siteResult.value, _.isUndefined) : {},
        siteResultWithExistingConfig.status === 'fulfilled' ? _.omitBy(siteResultWithExistingConfig.value, _.isUndefined) : {}
    );

    const analyticsData = {
        userId: user.id,
        analyzeSiteError: siteResult.status === 'rejected' ? siteResult.reason.message : '',
        analyzeSiteFromExistingConfigError:
            siteResultWithExistingConfig.status === 'rejected' ? siteResultWithExistingConfig.reason.message : '',
        isSbYamlAutogenerated: result.validation.hasConfig ? false : !_.isEmpty(result.config),
        autogeneratedSbYml: result.validation.hasConfig ? {} : result.config,
        modelsCount: result.config?.models.length ?? 0,
        initializer
    };

    logger.debug(analyticsMessage, {
        repoPath,
        ...analyticsData
    });

    analytics.track(analyticsMessage, analyticsData, user);

    return result;
};

export const analyze = async (
    user: IUserDoc,
    repoUrl: string,
    branch: string,
    options: { validateContent: boolean } = { validateContent: false },
    initializer: string
): Promise<IAnalyzeResult> => {
    const token = getUserOrPublicGithubToken(user);
    const { owner, repo } = decodeRepoUrl(repoUrl);
    const repoDetails = await fetchBranches({ owner, repo, token });
    const branches = repoDetails.map((branch: IBranch) => branch.name);
    const originalBranch = branch;
    let originalBranchIsValid = true;

    if (branch) {
        originalBranchIsValid = branches.includes(branch)
    }

    if (!originalBranchIsValid || !branch) {
        branch = await fetchDefaultBranch({ owner, repo, token });
    }

    const clonePath = await cloneTheme(user, repoUrl, branch, ['--depth=1', `--branch=${branch}`]);

    let result:IAnalyzeResult = {
        branch,
        branches,
        validation: {
            hasConfig: false
        },
        config: null
    };

    if (!originalBranchIsValid) {
        result.invalidBranch = originalBranch
    }

    try {
        const repoStack = await analyzeSiteStack({ user, repoPath: clonePath, validateContent: options.validateContent, initializer });

        result = Object.assign(result, repoStack);

        let packageJson = {};
        let packageJsonRaw;

        try {
            packageJsonRaw = await readFile(join(clonePath, repoStack.ssgDir ?? '', 'package.json'), 'utf8');
            if (packageJsonRaw) {
                packageJson = JSON.parse(packageJsonRaw);
            }
        } catch (e) {
            if (packageJsonRaw) {
                logger.error('Error parsing package.json of imported project');
            }
        }

        analytics.track(
            'Validate Stackbit.yml Done',
            {
                userId: user.id,
                ...getStackbitYamlValidationAnalyticsData({ packageJson, stackbitYamlFile: repoStack.config ?? null })
            },
            user
        );
    } finally {
        await cleanupTheme(clonePath);
    }

    return result;
};
