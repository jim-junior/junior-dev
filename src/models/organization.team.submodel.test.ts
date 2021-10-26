import type { default as OrganizationType } from './organization.model';
import type { default as UserType, IOrganizationMembership, IUser } from './user.model';
import type { ITeam } from './organization.team.submodel';
import { connectToDatabase, clearDatabase, closeDatabase } from '../test-utils/mongo';
import type * as mongooseType from 'mongoose';
import { fetchUser, loadUser } from '../test-utils/user';
import { expectedNotFoundError, getThrownError } from '../test-utils/error';
import { createOrganizationTeamUserPreset, fetchTeams, loadOrganization, organizationTestConfig } from '../test-utils/organization';
import { loadCommonRequireMock } from '../test-utils/requireMock';

describe('Organization Teams Sub Model', () => {
    let Organization: typeof OrganizationType;
    let User: typeof UserType;
    let mongoose: typeof mongooseType;
    let preset: Record<string, any>;

    beforeAll(async () => {
        jest.resetModules();
        mongoose = require('mongoose');
        await connectToDatabase(mongoose);
        loadCommonRequireMock(jest, organizationTestConfig);
        User = loadUser();
        Organization = loadOrganization();
    });
    beforeEach(async () => {
        await clearDatabase(mongoose);
        preset = await createOrganizationTeamUserPreset(User, Organization);
    });
    afterAll(() => closeDatabase(mongoose));

    test('statics.createTeam', async () => {
        const { org, team: presetTeam } = preset;
        const validInputTeam = { name: 'newTeam', logoPath: 'path' } as ITeam; // valid

        const missingRequiredFieldInputTeam = { logoPath: 'path' } as ITeam;
        const missingRequiredFieldError = await getThrownError(() => Organization.createTeam(org._id!, missingRequiredFieldInputTeam));
        expect(missingRequiredFieldError.toString()).toBe('ValidationError: teams: Validation failed: name: Path `name` is required.');

        const wrongOrgIdTeam = await Organization.createTeam(new mongoose.Types.ObjectId(), validInputTeam);
        expect(wrongOrgIdTeam).toBeNull();
        
        const org1Returned = await Organization.createTeam(org._id!, validInputTeam);
        expect(org1Returned!.teams).toHaveLength(2); // prechange, preset had 1 team
        const newTeamReturned = org1Returned!.teams!.filter((t) => !t!._id!.equals(presetTeam._id))![0]!;
        const teams = await fetchTeams(org._id!);
        expect(teams).toHaveLength(2);
        const newTeamFetched = teams.filter((t) => !t!._id!.equals(presetTeam._id))![0]!;
        for (const team of [newTeamFetched, newTeamReturned]) {
            expect(team!.name).toBe('newTeam');
            expect(team!.logoPath).toBe('path');
        }
    });

    test('static.updateTeam', async () => {
        const { org, team } = preset;
        const newId = new mongoose.Types.ObjectId();
        const validInputTeam = { name: 'newTeam', logoPath: 'path' } as ITeam; // valid

        let organization = await Organization.updateTeam(newId, team._id!, validInputTeam);
        expect(organization).toBeNull();

        organization = await Organization.updateTeam(org._id!, newId, validInputTeam);
        expect(organization).toBeNull();

        const updatedOrg = await Organization.updateTeam(org._id!, team._id, {
            name: 'newName',
            id: newId
        } as unknown as ITeam);
        expect(updatedOrg!.teams![0]!._id!).toStrictEqual(team._id!); // ignoring non updatable fields in update

        validInputTeam.name = 'FreshNewName';
        await Organization.updateTeam(org._id!, team._id!, validInputTeam);
        expect((await fetchTeams(org._id!))![0]!.name!).toStrictEqual(validInputTeam.name);
    });

    test('static.deleteTeam', async () => {
        const { org, team } = preset;
        let { user } = preset;
        await Organization.addUserToTeam(org._id!, team._id!, user._id!);
        user = await fetchUser(user._id!);
        let userTeams = user.organizationMemberships!.filter((membership: IOrganizationMembership) =>
            membership.organizationId.equals(org._id!)
        )![0]!;
        expect(userTeams.teams).toHaveLength(1); // user have team membership before deletion

        await Organization.deleteTeam(org._id!, team._id!);
        expect(await fetchTeams(org._id!)).toHaveLength(0); // org team deleted
        user = await fetchUser(user._id!);
        userTeams = user.organizationMemberships!.filter((membership: IOrganizationMembership) =>
            membership.organizationId.equals(org._id!)
        )![0]!;
        expect(userTeams.teams).toHaveLength(0); // user team membership deleted

        await Organization.deleteTeam(org._id!, team._id!); // idempotent: should not throw
    });

    test('statics.addUserToTeam', async () => {
        const { org, team } = preset;
        let { user } = preset;
        const newId = new mongoose.Types.ObjectId();

        await Organization.addUserToTeam(org._id!, team._id!, user._id!);
        user = await fetchUser(user._id!);
        expect(user.organizationMemberships![0]!.teams).toHaveLength(1);
        expect(user.organizationMemberships![0]!.teams![0]!).toStrictEqual(team._id!);

        // readding the same user doesn't create duplicate (idempotent)
        await Organization.addUserToTeam(org._id!, team._id!, user._id!);
        user = await fetchUser(user._id!);
        expect(user.organizationMemberships![0]!.teams).toHaveLength(1);
        expect(user.organizationMemberships![0]!.teams![0]!).toStrictEqual(team._id!);

        expect(
            await getThrownError(() => {
                return Organization.addUserToTeam(newId, team._id!, user._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown organization
        expect(
            await getThrownError(() => {
                return Organization.addUserToTeam(org._id!, newId, user._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown team
        expect(
            await getThrownError(() => {
                return Organization.addUserToTeam(org._id!, team._id!, newId);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown user

        const user2 = await User.createUser({ displayName: 'user2' } as Partial<IUser>);
        expect(
            await getThrownError(() => {
                return Organization.addUserToTeam(org._id!, team._id!, user2._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // can't add user outside the organization
    });

    test('statics.removeUserFromTeam', async () => {
        const { org, team } = preset;
        let { user } = preset;
        const newId = new mongoose.Types.ObjectId();
        await Organization.addUserToTeam(org._id!, team._id!, user._id!);
        user = await fetchUser(user._id!);
        expect(user.organizationMemberships![0]!.teams).toHaveLength(1);
        expect(user.organizationMemberships![0]!.teams![0]!).toStrictEqual(team._id!);

        expect(
            await getThrownError(() => {
                return Organization.removeUserFromTeam(newId, team._id!, user._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown organization
        expect(
            await getThrownError(() => {
                return Organization.removeUserFromTeam(org._id!, newId, user._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown team
        expect(
            await getThrownError(() => {
                return Organization.removeUserFromTeam(org._id!, team._id!, newId);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown user

        await Organization.removeUserFromTeam(org._id!, team._id!, user._id!);
        user = await fetchUser(user._id!);
        expect(user.organizationMemberships![0]!.teams).toHaveLength(0);

        await Organization.removeUserFromTeam(org._id!, team._id!, user._id!);
        user = await fetchUser(user._id!);
        expect(user.organizationMemberships![0]!.teams).toHaveLength(0); // idempotent: should not throw
    });
});
