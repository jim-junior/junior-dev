import type * as mongooseType from 'mongoose';
import type { default as ProjectType } from './project.model';
import type { default as OrganizationType, IOrganization } from './organization.model';
import type { IProjectGroup } from './organization.project-group.submodel';
import { connectToDatabase, clearDatabase, closeDatabase } from '../test-utils/mongo';
import { loadOrganization, organizationTestConfig } from '../test-utils/organization';
import { loadProject, projectTestConfig } from '../test-utils/project';
import { loadCommonRequireMock } from '../test-utils/requireMock';

describe('Organization ProjectGroups SubModel', () => {
    let Organization: typeof OrganizationType;
    let Project: typeof ProjectType;
    let mongoose: typeof mongooseType;

    beforeAll(async () => {
        jest.resetModules();
        mongoose = require('mongoose');
        await connectToDatabase(mongoose);
        loadCommonRequireMock(jest, { ...organizationTestConfig, ...projectTestConfig });
        Organization = loadOrganization();
        Project = loadProject();
    });

    beforeEach(() => {
        return clearDatabase(mongoose);
    });

    afterAll(() => {
        closeDatabase(mongoose);
    });

    test('statics.createProjectGroup', async () => {
        const createdOrganization = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const validProjectGroupMockData = { name: 'test project' };
        const organization = await Organization.createProjectGroup(createdOrganization._id!, validProjectGroupMockData);
        expect(organization!.projectGroups).toHaveLength(1);

        const newProjectGroup = (await organization!.getProjectGroups())![0]!;
        expect(newProjectGroup!.name).toBe(validProjectGroupMockData.name);

        // organization id is not correct
        const wrongOrgIdProjectGroup = await Organization.createProjectGroup(new mongoose.Types.ObjectId(), validProjectGroupMockData);
        expect(wrongOrgIdProjectGroup).toBeNull();
    });

    test('static.updateProjectGroup', async () => {
        const newId = new mongoose.Types.ObjectId();
        let validProjectGroupMockData = { name: 'test project' };
        let org = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const organization = await Organization.createProjectGroup(org._id!, { ...validProjectGroupMockData });
        const createdProjectGroup = (await organization!.getProjectGroups())![0]!;

        let updatedOrganization = await Organization.updateProjectGroup(newId, createdProjectGroup._id!, validProjectGroupMockData);
        expect(updatedOrganization).toBeNull();

        updatedOrganization = await Organization.updateProjectGroup(org._id!, newId, validProjectGroupMockData);
        expect(updatedOrganization).toBeNull();

        const updatedOrg = await Organization.updateProjectGroup(org._id!, createdProjectGroup._id!, {
            name: 'newName',
            id: newId
        } as unknown as IProjectGroup);
        expect(updatedOrg!.projectGroups![0]!._id!).toStrictEqual(createdProjectGroup._id!); // ignoring non updatable fields in update

        validProjectGroupMockData = {
            name: 'FreshNewName'
        };
        updatedOrganization = await Organization.updateProjectGroup(org._id!, createdProjectGroup._id!, validProjectGroupMockData);
        org = (await Organization.getOrganization(updatedOrganization!._id!))!;
        const updatedProjectGroup = (await org!.getProjectGroups())![0]!;
        expect(updatedProjectGroup.name!).toStrictEqual(validProjectGroupMockData.name);
    });

    test('static.deleteProjectGroup', async () => {
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
        await Project.addProjectToProjectGroup(project!._id!, createdProjectGroup!._id!);

        // check if project was added to project group
        const projectGroups = (await Project.findOne(project!._id!))!.projectGroupIds;
        expect(projectGroups?.toString()).toEqual([createdProjectGroup!._id!].toString());

        // check if project group was deleted
        await Organization.deleteProjectGroup(org._id!, createdProjectGroup!._id!);
        const fetchedOrg = (await Organization.getOrganization(org._id!))!;
        const orgPrGroups = (await fetchedOrg!.getProjectGroups())!;
        expect(orgPrGroups).toHaveLength(0);
        const prPrGroup = (await Project.findOne(project!._id!))!.projectGroupIds;
        expect(prPrGroup).toHaveLength(0);
    });
});
