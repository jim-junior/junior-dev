import type * as mongooseType from 'mongoose';
import type { default as ProjectType } from './project.model';
import type { default as OrganizationType, IOrganization } from './organization.model';
import { connectToDatabase, clearDatabase, closeDatabase } from '../test-utils/mongo';
import { loadOrganization, organizationTestConfig } from '../test-utils/organization';
import { loadProject, projectTestConfig } from '../test-utils/project';
import { loadCommonRequireMock } from '../test-utils/requireMock';
import { expectedNotFoundError, getThrownError } from '../test-utils/error';

describe('Project Model', () => {
    let mongoose: typeof mongooseType;
    let Project: typeof ProjectType;
    let Organization: typeof OrganizationType;

    beforeAll(async () => {
        jest.resetModules();
        mongoose = require('mongoose');
        await connectToDatabase(mongoose);
        loadCommonRequireMock(jest, { ...organizationTestConfig, ...projectTestConfig });
        Project = loadProject();
        Organization = loadOrganization();
    });

    beforeEach(async () => {
        await clearDatabase(mongoose);
    });

    afterAll(() => {
        closeDatabase(mongoose);
    });

    test('statics.create', async () => {
        expect.assertions(1);
        const user: any = {
            _id: mongoose.Types.ObjectId(),
            features: { defaultCustomerTier: 'free' }
        };
        expect(await Project.createProject({}, user)).toBeTruthy();
    });

    test('statics.create2', async () => {
        const user: any = {
            _id: mongoose.Types.ObjectId(),
            features: { defaultCustomerTier: 'free' }
        };
        expect(await Project.createProject({}, user)).toBeTruthy();
    });

    test('statics.addProjectToOrganization', async () => {
        const newId = new mongoose.Types.ObjectId();
        const org = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);

        const user: any = {
            _id: mongoose.Types.ObjectId(),
            features: { defaultCustomerTier: 'free' }
        };

        const project = await Project.createProject({}, user);

        expect(
            await getThrownError(() => {
                return Project.setOrganizationIdForProject(newId, org._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown project

        expect(
            await getThrownError(() => {
                return Project.setOrganizationIdForProject(project!._id!, newId);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown organization

        await Project.setOrganizationIdForProject(project!._id!, org._id!);
        // check if project has organizationId
        const organizationId = (await Project.findOne(project!._id!))!.organizationId;
        expect(organizationId).toEqual(org._id!);
    });

    test('statics.addProjectToProjectGroup', async () => {
        const newId = new mongoose.Types.ObjectId();
        const validProjectGroupMockData = { name: 'test project group' };
        const org = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const organization = await Organization.createProjectGroup(org._id!, { ...validProjectGroupMockData });
        const createdProjectGroup = (await organization!.getProjectGroups())![0]!;

        const user: any = {
            _id: mongoose.Types.ObjectId(),
            features: { defaultCustomerTier: 'free' }
        };

        const project = await Project.createProject({}, user);
        await Project.setOrganizationIdForProject(project!._id!, org._id!);

        expect(
            await getThrownError(() => {
                return Project.addProjectToProjectGroup(newId, createdProjectGroup!._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown project

        expect(
            await getThrownError(() => {
                return Project.addProjectToProjectGroup(project!._id!, newId);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown projectGroupIds

        await Project.addProjectToProjectGroup(project!._id!, createdProjectGroup!._id!);
        // check if project was added to project group
        const projectGroups = (await Project.findOne(project!._id!))!.projectGroupIds;
        expect(projectGroups?.toString()).toEqual([createdProjectGroup!._id!].toString());
    });

    test('statics.removeProjectFromProjectGroup', async () => {
        const newId = new mongoose.Types.ObjectId();
        const validProjectGroupMockData = { name: 'test project group' };
        const org = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const organization = await Organization.createProjectGroup(org._id!, { ...validProjectGroupMockData });
        const projectGroup = (await organization!.getProjectGroups())![0]!;

        const user: any = {
            _id: mongoose.Types.ObjectId(),
            features: { defaultCustomerTier: 'free' }
        };

        const project = await Project.createProject({}, user);
        await Project.setOrganizationIdForProject(project!._id!, org._id!);
        await Project.addProjectToProjectGroup(project!._id!, projectGroup!._id!);

        expect(
            await getThrownError(() => {
                return Project.removeProjectFromProjectGroup(newId, projectGroup!._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown project

        expect(
            await getThrownError(() => {
                return Project.removeProjectFromProjectGroup(project!._id!, newId);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown projectGroupIds

        await Project.removeProjectFromProjectGroup(project!._id!, projectGroup!._id!);
        const prPrGroup = (await Project.findOne(project!._id!))!.projectGroupIds;
        expect(prPrGroup).toHaveLength(0);
    });
});
