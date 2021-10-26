// organization related testing helpers

import type { default as OrganizationType, IOrganization } from '../models/organization.model';
import type { default as UserType, IUser } from '../models/user.model';
import type * as mongooseType from 'mongoose';
import type { ITeamDoc, ITeam } from '../models/organization.team.submodel';

let Organization: typeof OrganizationType;

export const organizationTestConfig = { userGroups: { regular: {} } };

export const loadOrganization = (): typeof OrganizationType => {
    Organization = require('../models/organization.model').default;
    return Organization;
};

export const fetchTeams = async (id: mongooseType.Types.ObjectId): Promise<ITeamDoc[]> => {
    const organization = await Organization.getOrganization(id!)!;
    return (await organization!.getTeams())!;
};

// creates and return common preset of Organization, Team and User
export const createOrganizationTeamUserPreset = async (
    User: typeof UserType,
    Organization: typeof OrganizationType
): Promise<Record<string, any>> => {
    let user = await User.createUser({
        displayName: 'user',
        email: 'user@user.co'
    } as Partial<IUser>);
    let org = await Organization.createOrganization({
        name: 'org'
    } as IOrganization);
    await Organization.addUser(org._id!, user._id!);
    org = (await Organization.createTeam(org._id!, {
        name: `team${org!.teams!.length + 1}`,
        logoPath: 'path'
    } as ITeam))!;
    const team = (await fetchTeams(org._id!))![0]!;
    await Organization.addUserToTeam(org._id!, team._id!, user._id!);
    user = (await User.findOne({ _id: user._id! }))!;

    return { org, team, user };
};
