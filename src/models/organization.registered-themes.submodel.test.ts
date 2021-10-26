import type * as mongooseType from 'mongoose';
import type { default as OrganizationType, IOrganization } from './organization.model';
import type { IRegisteredTheme } from './organization.registered-themes.submodel';
import { connectToDatabase, clearDatabase, closeDatabase } from '../test-utils/mongo';
import { loadOrganization, organizationTestConfig } from '../test-utils/organization';
import { loadCommonRequireMock } from '../test-utils/requireMock';

describe('Organization RegisteredThemes SubModel', () => {
    let Organization: typeof OrganizationType;
    let mongoose: typeof mongooseType;

    beforeAll(async () => {
        jest.resetModules();
        mongoose = require('mongoose');
        await connectToDatabase(mongoose);
        loadCommonRequireMock(jest, { ...organizationTestConfig });
        Organization = loadOrganization();
    });

    beforeEach(() => {
        return clearDatabase(mongoose);
    });

    afterAll(() => {
        closeDatabase(mongoose);
    });

    test('statics.createRegisteredTheme', async () => {
        const createdOrganization = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const validRegisteredThemeMockData = { name: 'test project', repoUrl: 'https://github.com/lwz7512/next-smooth-doc' };
        const organization = await Organization.createRegisteredTheme(createdOrganization._id!, validRegisteredThemeMockData);
        expect(organization!.registeredThemes).toHaveLength(1);

        const newRegisteredTheme = (await organization!.getRegisteredThemes())![0]!;
        expect(newRegisteredTheme!.name).toBe(validRegisteredThemeMockData.name);
        expect(newRegisteredTheme!.repoUrl).toBe(validRegisteredThemeMockData.repoUrl);

        // organization id is not correct
        const wrongOrgIdProjectGroup = await Organization.createProjectGroup(new mongoose.Types.ObjectId(), validRegisteredThemeMockData);
        expect(wrongOrgIdProjectGroup).toBeNull();
    });

    test('static.updateRegisteredTheme', async () => {
        const newId = new mongoose.Types.ObjectId();
        let validRegisteredThemeMockData = { name: 'test project', repoUrl: 'https://github.com/lwz7512/next-smooth-doc' };
        let org = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const organization = await Organization.createRegisteredTheme(org._id!, { ...validRegisteredThemeMockData });
        const createdRegisteredTheme = (await organization!.getRegisteredThemes())![0]!;

        let updatedOrganization = await Organization.updateRegisteredTheme(
            newId,
            createdRegisteredTheme._id!,
            validRegisteredThemeMockData
        );
        expect(updatedOrganization).toBeNull();

        updatedOrganization = await Organization.updateRegisteredTheme(org._id!, newId, validRegisteredThemeMockData);
        expect(updatedOrganization).toBeNull();

        const updatedOrg = await Organization.updateRegisteredTheme(org._id!, createdRegisteredTheme._id!, {
            name: 'newName',
            id: newId
        } as unknown as IRegisteredTheme);
        expect(updatedOrg!.registeredThemes![0]!._id!).toStrictEqual(createdRegisteredTheme._id!); // ignoring non updatable fields in update

        validRegisteredThemeMockData = {
            name: 'FreshNewName',
            repoUrl: 'https://github.com/lwz7512/next-smooth-doc'
        };
        updatedOrganization = await Organization.updateRegisteredTheme(org._id!, createdRegisteredTheme._id!, validRegisteredThemeMockData);
        org = (await Organization.getOrganization(updatedOrganization!._id!))!;
        const updatedRegisteredTheme = (await org!.getRegisteredThemes())![0]!;
        expect(updatedRegisteredTheme.name!).toStrictEqual(validRegisteredThemeMockData.name);
    });

    test('static.deleteRegisteredTheme', async () => {
        const validRegisteredThemeMockData = { name: 'test project group', repoUrl: 'https://github.com/lwz7512/next-smooth-doc' };
        const org = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const organization = await Organization.createRegisteredTheme(org._id!, { ...validRegisteredThemeMockData });
        const createdRegisteredTheme = (await organization!.getRegisteredThemes())![0]!;

        // check if project group was deleted
        await Organization.deleteRegisteredTheme(org._id!, createdRegisteredTheme!._id!);
        const fetchedOrg = (await Organization.getOrganization(org._id!))!;
        const orgRegThemes = (await fetchedOrg!.getRegisteredThemes())!;
        expect(orgRegThemes).toHaveLength(0);
    });
});
