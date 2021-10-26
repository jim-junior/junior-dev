import type * as mongooseType from 'mongoose';
import type { default as ProjectType } from './project.model';
import type { default as OrganizationType, IOrganization } from './organization.model';
import type { default as UserType, IUser } from './user.model';
import { connectToDatabase, clearDatabase, closeDatabase } from '../test-utils/mongo';
import { loadOrganization, organizationTestConfig } from '../test-utils/organization';
import { loadProject, projectTestConfig } from '../test-utils/project';
import { loadCommonRequireMock } from '../test-utils/requireMock';
import { expectedNotFoundError, getThrownError } from '../test-utils/error';
import { fetchUser, loadUser } from '../test-utils/user';

describe('User Model', () => {
    let mongoose: typeof mongooseType;
    let Project: typeof ProjectType;
    let User: typeof UserType;
    let Organization: typeof OrganizationType;

    beforeAll(async () => {
        jest.resetModules();
        mongoose = require('mongoose');
        await connectToDatabase(mongoose);
        loadCommonRequireMock(jest, { ...organizationTestConfig, ...projectTestConfig });
        Project = loadProject();
        User = loadUser();
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
        expect(await User.createUser(user)).toBeTruthy();
    });

    test('statics.addProjectToFavorites', async () => {
        const newId = new mongoose.Types.ObjectId();
        const user = await User.createUser({
            displayName: 'user',
            email: 'user@user.co',
            organizationMemberships: []
        } as Partial<IUser>);
        const org = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const project = await Project.createProject({ organizationId: org._id }, user);

        expect(
            await getThrownError(() => {
                return User.addProjectToFavorites(project!._id!, user!._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown organization

        await Organization.addUser(org._id!, user._id!);

        expect(
            await getThrownError(() => {
                return User.addProjectToFavorites(newId, user!._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown project

        expect(
            await getThrownError(() => {
                return User.addProjectToFavorites(project!._id!, newId);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown user

        await User.addProjectToFavorites(project!._id!, user!._id!);

        const foundUser = await fetchUser(user._id!);
        const userFavoriteProjects = foundUser?.organizationMemberships?.find(
            (orgItem) => orgItem!.organizationId.toString() === org!._id!.toString()
        )?.favoriteProjects;
        const favoriteProject = userFavoriteProjects?.find((projectItem) => projectItem!.toString() === project!._id!.toString());
        expect(userFavoriteProjects).toHaveLength(1);
        expect(favoriteProject?.toString()).toEqual(project!._id!.toString());
    });

    test('statics.removeProjectFromFavorites', async () => {
        const newId = new mongoose.Types.ObjectId();
        const user = await User.createUser({
            displayName: 'user',
            email: 'user@user.co',
            organizationMemberships: []
        } as Partial<IUser>);
        const org = await Organization.createOrganization({
            name: 'org'
        } as IOrganization);
        const project = await Project.createProject({ organizationId: org._id }, user);
        await Organization.addUser(org._id!, user._id!);
        await User.addProjectToFavorites(project!._id!, user!._id!);

        expect(
            await getThrownError(() => {
                return User.removeProjectFromFavorites(newId, user!._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown project

        expect(
            await getThrownError(() => {
                return User.removeProjectFromFavorites(project!._id!, newId);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown user

        await User.removeProjectFromFavorites(project!._id!, user!._id!);

        const foundUser = await fetchUser(user._id!);
        const userFavoriteProjects = foundUser?.organizationMemberships?.find(
            (orgItem) => orgItem!.organizationId.toString() === org!._id!.toString()
        )?.favoriteProjects;
        expect(userFavoriteProjects).toHaveLength(0);
    });
});
