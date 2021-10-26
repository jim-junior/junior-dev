import type { default as OrganizationType, IOrganization } from './organization.model';
import type { default as UserType, IUser } from './user.model';
import { connectToDatabase, clearDatabase, closeDatabase } from '../test-utils/mongo';
import type * as mongooseType from 'mongoose';
import { fetchUser, loadUser } from '../test-utils/user';
import { loadOrganization, createOrganizationTeamUserPreset, organizationTestConfig } from '../test-utils/organization';
import { expectedNotFoundError, getThrownError } from '../test-utils/error';
import { loadCommonRequireMock } from '../test-utils/requireMock';

describe('Organization Model', () => {
    let Organization: typeof OrganizationType;
    let User: typeof UserType;
    let mongoose: typeof mongooseType;

    beforeAll(async () => {
        jest.resetModules();
        mongoose = require('mongoose');
        await connectToDatabase(mongoose);
        loadCommonRequireMock(jest, organizationTestConfig);
        User = loadUser();
        Organization = loadOrganization();
    });
    afterAll(() => closeDatabase(mongoose));
    beforeEach(() => clearDatabase(mongoose));

    test('methods.save', async () => {
        const org = new Organization({ name: 'org', notInSchma: 'x' });
        const savedOrg = await org.save();
        expect(savedOrg).toEqual(
            expect.objectContaining({
                _id: expect.any(mongoose.Types.ObjectId),
                name: 'org',
                createdAt: expect.any(Date),
                updatedAt: expect.any(Date)
            })
        );
        expect((savedOrg as any).notInSchema).toBeUndefined();

        await expect(new Organization({ noName: 'z' }).save()).rejects.toThrow(
            'Organization validation failed: name: Path `name` is required.'
        );
    });

    test('statics.createOrganization', async () => {
        const createdOrg = await Organization.createOrganization({ name: 'org1' } as IOrganization);

        expect(createdOrg).toEqual(
            expect.objectContaining({
                _id: expect.any(mongoose.Types.ObjectId),
                id: expect.any(String),
                name: 'org1',
                createdAt: expect.any(Date),
                updatedAt: expect.any(Date)
            })
        );
        expect((createdOrg as any).notInSchema).toBeUndefined();

        expect(
            (
                await getThrownError(() => {
                    return Organization.createOrganization({ noName: 'z' } as any as IOrganization);
                })
            ).toString()
        ).toBe('ValidationError: name: Path `name` is required.');
    });

    test('statics.updateOrganization', async () => {
        const org = await Organization.createOrganization({ name: 'org1' } as IOrganization);
        const newId = new mongoose.Types.ObjectId();
        const validUpdate = { name: 'newOrg' };

        // organization not exists
        const organization = await Organization.updateOrganization(newId, validUpdate);
        expect(organization).toBeNull();

        const updatedOrg = (await Organization.updateOrganization(org._id!, validUpdate))!;

        expect(updatedOrg).toEqual(
            expect.objectContaining({
                id: org.id,
                name: 'newOrg',
                createdAt: org.createdAt
            })
        );
        expect(updatedOrg.updatedAt.getTime()).toBeGreaterThan(org.updatedAt.getTime());

        const updateRestrictedFields = (await Organization.updateOrganization(org._id!, {
            updatedAt: org.updatedAt,
            _id: newId,
            createdAt: new Date()
        } as unknown as Partial<Pick<IOrganization, 'name'>>))!;
        expect(updateRestrictedFields).toEqual(
            expect.objectContaining({
                id: org.id,
                name: 'newOrg',
                createdAt: org.createdAt
            })
        );
        expect(updateRestrictedFields.updatedAt.getTime()).toBeGreaterThan(updatedOrg.updatedAt.getTime());
    });

    test('statics.deleteOrganization', async () => {
        const org = await Organization.createOrganization({ name: 'org1' } as IOrganization);
        const newId = new mongoose.Types.ObjectId();

        await Organization.deleteOrganization(newId); // delete return ok as org not exist

        await Organization.deleteOrganization(org._id!);

        const organization = await Organization.getOrganization(org._id!);
        expect(organization).toBeNull();

        await Organization.deleteOrganization(org._id!); // delete return ok as org not exist
    });

    test('statics.addUser', async () => {
        let user = await User.createUser({ displayName: 'user' } as Partial<IUser>);
        let org = await Organization.createOrganization({ name: 'org' } as IOrganization);
        const newId = new mongoose.Types.ObjectId();

        expect(
            await getThrownError(() => {
                return Organization.addUser(newId, user._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown org id

        expect(
            await getThrownError(() => {
                return Organization.addUser(org._id!, newId!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown user id

        await Organization.addUser(org._id!, user._id!);
        // organization added to user membership
        user = (await fetchUser(user._id!))!;
        expect(user.organizationMemberships).toHaveLength(1);
        const membership = user.organizationMemberships![0]!;
        expect(membership.organizationId).toStrictEqual(org._id!);

        // organization can be found by the user
        org = (await Organization.findOrganizations(user))![0]!;
        expect(org._id!).toStrictEqual(org._id);
        // getUsers method reflect the membership
        const users = await org.getUsers();
        expect(users!).toHaveLength(1);
        expect(users![0]!._id!).toStrictEqual(user._id);

        // readding the same user works (idempotent)
        await Organization.addUser(org._id!, user._id!);
    });

    test('statics.removeUser', async () => {
        let user = await User.createUser({ displayName: 'user' } as Partial<IUser>);
        const org = await Organization.createOrganization({ name: 'org' } as IOrganization);

        const newId = new mongoose.Types.ObjectId();

        expect(
            await getThrownError(() => {
                return Organization.removeUser(newId, user._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown org id

        expect(
            await getThrownError(() => {
                return Organization.removeUser(org._id!, newId!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown user id

        Organization.removeUser(org._id!, user._id!);
        // organization removed from user membership
        user = (await fetchUser(user._id!))!;
        expect(user.organizationMemberships).toHaveLength(0);
        // organization can't be found by the user
        expect(await Organization.findOrganizations(user)).toHaveLength(0);
        // getUsers method reflect the membership
        const users = await org.getUsers();
        expect(users!).toHaveLength(0);

        // removing removed user works (idempotent)
        await Organization.removeUser(org._id!, user._id!);
    });

    test('statics.getOrganization', async () => {
        // unknown org id
        const newId = new mongoose.Types.ObjectId();
        const organization = await Organization.getOrganization(newId);
        expect(organization).toBeNull();

        const { org, team } = await createOrganizationTeamUserPreset(User, Organization);
        const orgOutput = (await Organization.getOrganization(org._id!))!;

        expect(orgOutput).toEqual(
            expect.objectContaining({
                id: org.id,
                name: org.name,
                createdAt: org.createdAt,
                updatedAt: org.updatedAt
            })
        );
        expect(orgOutput.teams).toHaveLength(1);
        expect(orgOutput.teams![0]!).toEqual(
            expect.objectContaining({
                id: team.id,
                name: team.name
            })
        );
    });

    test('statics.findOrganizations', async () => {
        const { user, org, team } = await createOrganizationTeamUserPreset(User, Organization);

        const orgOutput = (await Organization.findOrganizations(user))![0]!;

        expect(Object.keys(orgOutput)).toHaveLength(7);
        expect(orgOutput).toEqual(
            expect.objectContaining({
                id: org.id,
                name: org.name,
                createdAt: org.createdAt,
                updatedAt: org.updatedAt
            })
        );
        expect(orgOutput.projectGroups).toHaveLength(0);
        expect(orgOutput.teams).toHaveLength(1);
        expect(orgOutput.teams![0]!).toEqual(
            expect.objectContaining({
                id: team.id,
                name: team.name
            })
        );
    });

    test('statics.objectForResponse', async () => {
        const { org, team } = await createOrganizationTeamUserPreset(User, Organization);

        const orgOutput = (await Organization.objectForResponse(org))!;

        expect(Object.keys(orgOutput)).toHaveLength(7);
        expect(orgOutput).toEqual(
            expect.objectContaining({
                id: org.id,
                name: org.name,
                createdAt: org.createdAt,
                updatedAt: org.updatedAt
            })
        );
        expect(orgOutput.projectGroups).toHaveLength(0);
        expect(orgOutput.teams).toHaveLength(1);
        expect(orgOutput.teams![0]!).toEqual(
            expect.objectContaining({
                id: team.id,
                name: team.name
            })
        );
    });

    test('statics.objectForListResponse', async () => {
        const { org } = await createOrganizationTeamUserPreset(User, Organization);

        const orgOutput = (await Organization.objectForListResponse(org))!;

        expect(Object.keys(orgOutput)).toHaveLength(4);
        expect(orgOutput).toEqual(
            expect.objectContaining({
                id: org.id,
                name: org.name,
                createdAt: org.createdAt,
                updatedAt: org.updatedAt
            })
        );
        expect((orgOutput as any).teams).toBeUndefined();
        expect((orgOutput as any).registeredThemes).toBeUndefined();
    });

    test('statics.teamForResponse', async () => {
        const { team } = await createOrganizationTeamUserPreset(User, Organization);

        const outputTeam = await Organization.teamForResponse(team);
        expect(Object.keys(outputTeam)).toHaveLength(3);
        expect(outputTeam.id).toBeDefined();
        expect(outputTeam.name).toBeDefined();
        expect(outputTeam.logoPath).toBeDefined();
    });

    test('statics.userForListResponse', async () => {
        const { user, org, team } = await createOrganizationTeamUserPreset(User, Organization);

        const newId = new mongoose.Types.ObjectId();
        const unknownOrgIdOutputUserResponse = (await Organization.userForListResponse(newId, user))!;
        expect(unknownOrgIdOutputUserResponse.teamIds).toHaveLength(0);

        const outputUserResponse = (await Organization.userForListResponse(org!._id!, user))!;
        expect(Object.keys(outputUserResponse)).toHaveLength(4);
        expect(outputUserResponse).toEqual(
            expect.objectContaining({
                id: user.id,
                displayName: user.displayName,
                email: user.email
            })
        );
        expect(outputUserResponse.teamIds).toHaveLength(1);
        expect(outputUserResponse.teamIds[0]).toStrictEqual(team.id);
    });

    test('statics.projectGroupForResponse', async () => {
        const createdOrganization = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const validProjectGroupMockData = { name: 'test project' };
        const organization = await Organization.createProjectGroup(createdOrganization._id!, validProjectGroupMockData);
        const projectGroup = (await organization!.getProjectGroups())![0]!;

        const projectGroupJSON = (await Organization.projectGroupForResponse(projectGroup))!;
        expect(projectGroupJSON).toEqual(
            expect.objectContaining({
                id: projectGroup.id,
                name: projectGroup.name
            })
        );
    });
});
