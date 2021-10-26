import { resolve, join } from 'path';
import { readdir } from 'fs/promises';
import mongooseType from 'mongoose';
import type * as expressType from 'express';
import type * as passportTypes from 'passport';
import { clearDatabase, connectToDatabase } from './mongo';

// use jest types
export const loadCommonRequireMock = (jest: Record<any, any>, testConfig: Record<any, any>): void => {
    const config = {
        ...testConfig,
        default: testConfig,
        loadConfig: () => Promise.resolve(testConfig),
    };
    jest.mock(resolve(process.cwd(), 'src/base-config'), () => (config));
    jest.mock(resolve(process.cwd(), 'src/config'), () => (config));
    jest.mock(resolve(process.cwd(), 'src/services/analytics/analytics'), () => ({
        track: jest.fn(),
    }));
    jest.mock(resolve(process.cwd(), 'src/services/logger'), () => ({
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn()
    }));
    jest.mock(resolve(process.cwd(), 'src/services/customerio-service/customerio-transactional-service'), () => ({
        inviteCollaboratorEmail: jest.fn(),
    }));
};

export const mockMiddleware = (req: expressType.Request, res: expressType.Response, next: expressType.NextFunction): void => {
    next();
};

// use jest types
export const mockServerModules = ({ jest, mongoose, passport }: { jest: Record<any, any>, mongoose: typeof mongooseType, passport: typeof passportTypes}): void => {
    jest.mock('source-map-support', () => ({
        install: jest.fn()
    }));
    jest.mock('aws-sdk', () => ({
        SharedIniFileCredentials: jest.fn(),
        S3: jest.fn().mockImplementation(),
        config: {
            credentials: {},
            update: jest.fn(),
        },
    }));

    jest.mock('@sentry/node', () => ({
        init: jest.fn(),
        Handlers: {
            requestHandler: () => mockMiddleware,
            errorHandler: () => mockMiddleware,
        },
    }));

    const morgan = () => mockMiddleware;
    morgan['token'] = () => 'foo';
    jest.mock('morgan', () => morgan);
    jest.mock(resolve(process.cwd(),'src/models/init-mongo'), () => {
        return {
            mongooseConnection: mongoose.connection,
        };
    });

    jest.mock(resolve(process.cwd(), 'src/services/auth-service/passport-init'), () => passport);
    jest.mock(resolve(process.cwd(), 'src/services/deploy-services/container-orchestration-service'), () => ({
        initializeContainerEnvironments: jest.fn(),
    }));

    jest.mock(resolve(process.cwd(), 'src/services/services'), () => ({
        init: async () => {
            await connectToDatabase(mongoose);
            await clearDatabase(mongoose);
        },
    }));
};

export const mockAllRouters = async ({whitelistedRouters = [], jest }: { whitelistedRouters: string[], jest: Record<any, any> }): Promise<void> => {
    const routerPath = resolve(process.cwd(), 'src/routers');
    const routers = (await readdir(routerPath)).filter(filename => filename.match(/\.router\.(t|j)s/) && filename !== 'index.router.js');
    const filteredRoutes = routers.filter(router => !whitelistedRouters.includes(router));
    filteredRoutes.forEach(routerName => {
        jest.mock(join(routerPath, routerName), () => mockMiddleware);
    });
};

const projectRoutesToBeMoved = [
    'generateProjectId',
    'quickDeploy',
    'analyzeRepo',
    'deployProject',
    'deployPreview',
    'createProjectAndDeployPreview',
    'deployWebflow',
    'renameProject',
    'checkName',
    'getMyProjects',
    'getMyDashboardProjects',
    'getProject',
    'updateProject',
    'importNetlifySite',
    'duplicateProject',
    'redeployProject',
    'deleteProject',
    'getProjectPreview',
    'buildWebhook',
    'githubWebhook',
    'netlifyWebhook',
    'googleWebhook',
    'refreshContent',
    'containerWebhook',
    'projectWebhook',
    'contentVersion',
    'hasCmsAccess',
    'canStartContainer',
    'hasDeploymentAccess',
    'buildProject',
    'publishContent',
    'hasChanges',
    'makeAction',
    'sendTrialEmail',
    'splitTestAction',
    'schedulePublish',
    'removeScheduledPublish',
    'publishContentWithToken',
    'requestPublish',
    'projectLogs',
    'projectHealth',
    'hasChangesOnEnvironments',
    'getProjectConfig',
    'updateStackbitSchema',
    'generateStackbitSchema',
    'handleFormSubmission',
    'handleStripeWebhook',
    'getSubscription',
    'createSubscription',
    'editSubscription',
    'startTrial',
    'unsetSubscriptionFlag',
    'getConfig',
    'updateConfig',
    'addProjectToProjectGroup',
    'removeProjectFromProjectGroup',
];

export const mockAllProjectRoutes = async ({ whitelistedRoutes = [], jest }: { whitelistedRoutes: string[], jest: Record<any, any> }): Promise<void> => {
    const routesPath = resolve(process.cwd(), 'src/routers/routes/project');
    const routes = (await readdir(routesPath)).filter(filename => filename !== 'index.ts');

    const filteredRoutes = routes.filter(route => !whitelistedRoutes.includes(route));
    filteredRoutes.forEach(routerName => {
        jest.mock(resolve(process.cwd(), `src/routers/routes/${routerName}`), () => mockMiddleware);
    });

    // todo migrate to iterating over files from src/routers/routes/project-routes folder
    const filteredRoutesToBeMoved = projectRoutesToBeMoved.filter(route => !whitelistedRoutes.includes(route));
    const routesToBeMoved = filteredRoutesToBeMoved.reduce((acc: any, routeName: string) => {
        acc[routeName] = jest.fn();
        return acc;
    }, {});

    jest.mock(resolve(process.cwd(), 'src/routers/routes/project.routes.js'), () => (routesToBeMoved));
};

