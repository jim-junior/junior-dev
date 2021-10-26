import type * as CustomerTierService from './customer-tier-service';
const testConfig = require('./customer-tier-service.test-data').config;

const mockUserModel = () => ({
    findUserById: jest.fn()
});

const mockProjectModel = () => ({
    addCurrentTierToPastTiers: jest.fn(),
    disableCollaboratorsByTypes: jest.fn(),
    limitNumberOfCollaboratorsEnabled: jest.fn(),
    limitNumberOfViewersCollaboratorsEnabled: jest.fn(),
    findUserById: jest.fn()
});

describe('Customer Tier Service', () => {
    let customerTierService: typeof CustomerTierService;
    let User: ReturnType<typeof mockUserModel>;
    let Project: ReturnType<typeof mockProjectModel>;

    beforeEach(() => {
        jest.resetModules();
        jest.mock('../../config', () => testConfig);
        jest.mock('../customerio-service/customerio-transactional-service', () => ({
            sendPlansEmail: jest.fn(),
            PLANS_EMAIL_EVENT: {
                STARTED: 'PLAN_STARTED'
            }
        }));
        jest.mock('../analytics/analytics', () => ({
            track: jest.fn()
        }));
        jest.mock('../logger', () => ({
            info: jest.fn()
        }));
        jest.mock('../deploy-services/split-test-service', () => ({
            cleanupSplitTest: jest.fn()
        }));
        jest.mock('../../models/user.model', () => ({
            default: mockUserModel()
        }));
        jest.mock('../../models/project.model', () => ({
            default: mockProjectModel()
        }));
        customerTierService = require('./customer-tier-service');
        User = require('../../models/user.model').default;
        Project = require('../../models/project.model').default;
    });

    test('getById', () => {
        expect(customerTierService.getById('free')).toStrictEqual(testConfig.customerTiers.free);
        expect(customerTierService.getById('braze')).toBeUndefined();
    });

    test('updateProjectAfterTierChange', async () => {
        expect.hasAssertions();
        const project: any = {
            id: 'abcdef',
            ownerId: '1234567890',
            subscription: {
                safeTierId: 'free',
                tierId: 'free'
            },
            splitTests: [],
            siteUrl: 'https://www.example.com/',

            getCustomerTier() {
                return {
                    features: testConfig.customerTiers.free.features
                };
            }
        };
        for (const method of [
            'addCurrentTierToPastTiers',
            'disableCollaboratorsByTypes',
            'limitNumberOfCollaboratorsEnabled',
            'limitNumberOfViewersCollaboratorsEnabled'
        ]) {
            (Project as any)[method].mockResolvedValue(project);
        }

        const user = {
            id: '1234567890',
            email: 'user@example.com'
        };
        User.findUserById.mockResolvedValue(user);

        expect(await customerTierService.updateProjectAfterTierChange(project, 'business')).toStrictEqual(project);

        expect(Project.addCurrentTierToPastTiers.mock.calls).toEqual([[project]]);
        expect(Project.disableCollaboratorsByTypes.mock.calls).toEqual([[project, ['editor', 'developer']]]);
        expect(Project.limitNumberOfCollaboratorsEnabled.mock.calls).toEqual([[project, 0]]);
        expect(Project.limitNumberOfViewersCollaboratorsEnabled.mock.calls).toEqual([[project, 100]]);

        expect(User.findUserById.mock.calls).toEqual([['1234567890']]);

        expect(require('../logger').info.mock.calls).toHaveLength(1);
        expect(require('../deploy-services/split-test-service').cleanupSplitTest.mock.calls).toHaveLength(0);
        expect(require('../analytics/analytics').track.mock.calls).toHaveLength(0);
        expect(require('../customerio-service/customerio-transactional-service').sendPlansEmail.mock.calls).toEqual([
            [
                project,
                project.subscription.tierId,
                'PLAN_STARTED'
            ]
        ]);
    });
});
