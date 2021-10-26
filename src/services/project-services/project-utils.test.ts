import _ from 'lodash';
import mongooseType from 'mongoose';
import { IUserDoc } from '../../models/user.model';
import { IProjectDoc } from '../../models/project.model';
import { clearDatabase, closeDatabase, connectToDatabase } from '../../test-utils/mongo';
import { createUser } from '../../test-utils/user';
import { loadCommonRequireMock } from '../../test-utils/requireMock';
import { createProject } from '../../test-utils/project';
import type { default as ProjectUtilsType } from './project-utils';

const config = {
    customerTiers: {
        free: {
            name: 'Free',
            attributes: {
                isFree: true,
                isTrial: false,
            },
            features: {
                hpPreviews: false,
                containerMaxInactivityTimeInMinutes: 30,
                wysiwyg: true,
                collaborators: 0,
                environments: 0,
                diff: false,
                merge: false,
                abTesting: false,
                approval: false,
                pageGranularity: false,
                verifiedPublish: false,
                crossPageDep: false,
                undo: false,
                scheduledPublish: false,
                collaboratorRoles: false,
                developerTools: true,
                settingsConnectedServices: true,
                settingsAdvanced: true,
                supportAction: 'contactPage',
                hasViewerRole: true,
                // 1 user is for testing purposes
                viewersCollaborators: 2,
            },
            upgradeHookScheme: 'test',
        },
        business: {
            name: 'Business',
            attributes: {
                isFree: false,
                isTrial: false,
                downgradesTo: 'free',
            },
            stripeProductId: 'prod_abcd',
            defaultPlan: 'price_abcd',
            features: {
                hpPreviews: false,
                containerMaxInactivityTimeInMinutes: 1440,
                wysiwyg: true,
                collaborators: 9,
                environments: 2,
                diff: false,
                merge: false,
                abTesting: false,
                approval: false,
                pageGranularity: true,
                verifiedPublish: false,
                crossPageDep: false,
                undo: false,
                scheduledPublish: true,
                collaboratorRoles: true,
                developerTools: true,
                settingsConnectedServices: true,
                settingsAdvanced: true,
                supportAction: 'contactPage',
                hasViewerRole: true,
                viewersCollaborators: 100,
            },
            upgradeHookScheme: 'test',
        }
    },
    upgradeHookSchemes: {
        test: {
            splitTesting: {
                trialTiers: [
                    {
                        id: 'business-trial',
                    },
                ],
            },
            granularPublishing: {
                trialTiers: [
                    {
                        id: 'business-trial',
                    },
                ],
            },
            scheduledPublishing: {
                trialTiers: [
                    {
                        id: 'business-trial',
                    },
                ],
            },
            collaborators: {
                trialTiers: [
                    {
                        id: 'business-trial',
                    },
                ],
            },
            collaboratorRoles: {
                trialTiers: [
                    {
                        id: 'business-trial',
                    },
                ],
            },
        },
    },
    userGroups: {
        regular: {},
    },
    v2themes: ['https://github.com/stackbit/stackbit-nextjs-starter'],
    v2deployments: ['netlify']
};

describe('project-utils', () => {
    let user: IUserDoc;
    let project: IProjectDoc;
    let mongoose: typeof mongooseType;

    beforeAll(async () => {
        jest.resetModules();
        mongoose = require('mongoose');
        await connectToDatabase(mongoose);
        loadCommonRequireMock(jest, config);
        user = await createUser();
        project = await createProject(user);
    });

    afterAll(() => closeDatabase(mongoose));
    beforeEach(() => clearDatabase(mongoose));

    describe('isV2Supported', () => {
        let isV2Supported: typeof ProjectUtilsType.isV2Supported;

        beforeAll(() => {
            const utils = require('./project-utils').default;
            isV2Supported = utils.isV2Supported;
        });

        test('for project with no v2 theme', () => {
            _.set(project, 'wizard.theme.settings.source', 'https://github.com/stackbit-themes/azimuth-nextjs');
            expect(isV2Supported(project)).toBeFalsy();
        });

        test('for project with not supported v2 deployment', () => {
            _.set(project, 'wizard.deployment.id', 'azure');
            expect(isV2Supported(project)).toBeFalsy();
        });

        test('for project with v2 supported', () => {
            _.set(project, 'wizard.deployment.id', 'netlify');
            _.set(project, 'wizard.theme.settings.source', 'https://github.com/stackbit/stackbit-nextjs-starter');
            expect(isV2Supported(project)).toBeTruthy();
        });
    });
});
