import { makeTypeSafeSchema } from './model-utils';
import type { Writeable, MongooseTimestamps } from '../type-utils';
import mongoose, { Model, Document, Schema, Types } from 'mongoose';
import mongoose_delete, { SoftDeleteModel } from 'mongoose-delete';
import type { IUserDoc, IOrganizationMembership } from './user.model';
import {
    ITeam,
    ITeamDoc,
    ITeamJSON,
    TeamSchema,
    registerOrganizationTeamFunctions,
    ITeamUpdatableFields
} from './organization.team.submodel';
import { ResponseError } from '../services/utils/error.utils';
import User from './user.model';
import {
    IProjectGroup,
    IProjectGroupUpdatable,
    IProjectGroupDoc,
    IProjectGroupJSON,
    ProjectGroupSchema,
    registerOrganizationProjectGroupMethods
} from './organization.project-group.submodel';
import {
    IRegisteredTheme,
    IRegisteredThemeDoc,
    IRegisteredThemeUpdatableFields,
    IRegisteredThemeJSON,
    RegisteredThemeSchema,
    registerOrganizationRegisteredThemeFunctions
} from './organization.registered-themes.submodel';

export interface IOrganization {
    name: string;
    teams?: ITeam[];
    projectGroups?: IProjectGroup[];
    registeredThemes?: IRegisteredTheme[];
}
const ORGANIZATION_UPDATABLE_FIELDS = ['name'] as const;
export type IOrganizationUpdatableFields = Pick<IOrganization, typeof ORGANIZATION_UPDATABLE_FIELDS[number]>;

export interface IOrganizationDoc extends IOrganization, Document<Types.ObjectId>, MongooseTimestamps {
    id?: string;

    // references as documents
    teams?: ITeamDoc[];
    projectGroups?: IProjectGroupDoc[];
    registeredThemes?: IRegisteredThemeDoc[];

    getUsers(): Promise<IUserDoc[]>;
    getTeams(): Promise<ITeamDoc[] | undefined>;
    getProjectGroups(): Promise<IProjectGroupDoc[] | undefined>;
    getRegisteredThemes(): Promise<IRegisteredThemeDoc[] | undefined>;
}

export type IOrganizationJSON = Writeable<Omit<IOrganization, 'teams' | 'projectGroups' | 'registeredThemes'>> &
    MongooseTimestamps &
    Writeable<Pick<IOrganizationDoc, 'id'>> & {
        teams?: ITeamJSON[];
        projectGroups?: IProjectGroupJSON[];
        registeredThemes?: IRegisteredThemeJSON[];
    };

export type IOrganizationSimpleJSON = Omit<IOrganizationJSON, 'registeredThemes' | 'teams' | 'projectGroups'>;
export type IOrganizationUserSimpleJSON = Pick<IUserDoc, 'id' | 'email' | 'displayName'> & {
    teamIds: string[];
};

export interface IOrganizationModel extends Model<IOrganizationDoc>, SoftDeleteModel<IOrganizationDoc> {
    // statics
    createOrganization(organization: Partial<IOrganizationUpdatableFields>): Promise<IOrganizationDoc>;
    updateOrganization(id: Types.ObjectId, updatedOrganization: Partial<IOrganizationUpdatableFields>): Promise<IOrganizationDoc | null>;
    deleteOrganization(id: Types.ObjectId): Promise<void>;
    findOrganizations(user: IUserDoc): Promise<IOrganizationDoc[]>;
    getOrganization(id: Types.ObjectId): Promise<IOrganizationDoc | null>;

    // organization user membership
    addUser(id: Types.ObjectId, userId: Types.ObjectId): void;
    removeUser(id: Types.ObjectId, userId: Types.ObjectId): void;

    // team (implemented in team submodel)
    createTeam(id: Types.ObjectId, team: Partial<ITeamUpdatableFields>): Promise<IOrganizationDoc | null>;
    updateTeam(id: Types.ObjectId, teamId: Types.ObjectId, team: Partial<ITeamUpdatableFields>): Promise<IOrganizationDoc | null>;
    deleteTeam(id: Types.ObjectId, teamId: Types.ObjectId): Promise<void>;

    // team user membership (implemented in team submodel)
    addUserToTeam(id: Types.ObjectId, teamId: Types.ObjectId, userId: Types.ObjectId): void;
    removeUserFromTeam(id: Types.ObjectId, teamId: Types.ObjectId, userId: Types.ObjectId): void;

    // project groups
    createProjectGroup(organizationId: Types.ObjectId, projectGroup: Partial<IProjectGroupUpdatable>): Promise<IOrganizationDoc | null>;
    updateProjectGroup(
        organizationId: Types.ObjectId,
        projectGroupId: Types.ObjectId,
        updatedProjectGroup: Partial<IProjectGroupUpdatable>
    ): Promise<IOrganizationDoc | null>;
    deleteProjectGroup(organizationId: Types.ObjectId, projectGroupId: Types.ObjectId): Promise<void>;

    // registered themes
    createRegisteredTheme(id: Types.ObjectId, registeredTheme: Partial<IRegisteredThemeUpdatableFields>): Promise<IOrganizationDoc | null>;
    updateRegisteredTheme(
        id: Types.ObjectId,
        registeredThemeId: Types.ObjectId,
        registeredTheme: Partial<IRegisteredThemeUpdatableFields>
    ): Promise<IOrganizationDoc | null>;
    deleteRegisteredTheme(id: Types.ObjectId, registeredThemeId: Types.ObjectId): Promise<void>;

    // output
    objectForResponse(organization: IOrganizationDoc): Promise<IOrganizationJSON>;
    objectForListResponse(organization: IOrganizationDoc): Promise<IOrganizationSimpleJSON>;
    teamForResponse(team: ITeamDoc): Promise<ITeamJSON>;
    userForListResponse(id: Types.ObjectId, user: IUserDoc): Promise<IOrganizationUserSimpleJSON>;
    projectGroupForResponse(projectGroup: IProjectGroupDoc): Promise<IProjectGroupJSON>;
    registeredThemeForResponse(registeredTheme: IRegisteredThemeDoc): Promise<IRegisteredThemeJSON>;
}

const OrganizationSchema = makeTypeSafeSchema(
    new Schema<IOrganizationDoc, IOrganizationModel>(
        {
            name: { type: String, required: true },
            teams: [TeamSchema],
            projectGroups: [ProjectGroupSchema],
            registeredThemes: [RegisteredThemeSchema]
        } as Record<keyof IOrganization, any>,
        { timestamps: true }
    )
);

OrganizationSchema.plugin(mongoose_delete, {
    deletedAt: true,
    overrideMethods: ['count', 'find', 'findOne', 'findOneAndUpdate']
});

OrganizationSchema.statics.addUser = async function (id, userId) {
    const organization = await Organization.findById(id);
    const user = await User.findById(userId);
    if (organization && user) {
        const newMembership = { organizationId: id, favoriteProjects: [], teams: [] } as IOrganizationMembership;
        await User.findOneAndUpdate(
            { _id: userId, 'organizationMemberships.organizationId': { $ne: id } },
            { $addToSet: { organizationMemberships: newMembership } },
            { new: true, runValidators: true }
        );
    } else {
        throw new ResponseError('NotFound');
    }
};

OrganizationSchema.statics.removeUser = async function (id, userId) {
    const organization = await Organization.findById(id);
    if (organization) {
        const updatedUser = await User.findOneAndUpdate({ _id: userId }, { $pull: { organizationMemberships: { organizationId: id } } });
        if (updatedUser) {
            return updatedUser;
        }
    }

    // organization or user does not exist
    throw new ResponseError('NotFound');
};
OrganizationSchema.methods.getUsers = async function () {
    return User.find({ 'organizationMemberships.organizationId': this._id });
};

registerOrganizationTeamFunctions(OrganizationSchema);
registerOrganizationProjectGroupMethods(OrganizationSchema);
registerOrganizationRegisteredThemeFunctions(OrganizationSchema);

OrganizationSchema.statics.createOrganization = async function (organization) {
    const newOrganization = { name: organization.name, _id: mongoose.Types.ObjectId() };
    return new Organization(newOrganization).save();
};

OrganizationSchema.statics.updateOrganization = async function (id, updatedOrganization) {
    const updateValues = updatedOrganization as Record<string, any>;
    const updateSet: Record<string, any> = {};
    ORGANIZATION_UPDATABLE_FIELDS.forEach((key) => {
        if (updateValues[key]) {
            updateSet[key] = updateValues[key];
        }
    });
    return Organization.findOneAndUpdate({ _id: id }, { $set: updateSet }, { new: true });
};

OrganizationSchema.statics.deleteOrganization = async function (id) {
    await Organization.delete({ _id: id });

    // delete all user membership to this organization
    await User.updateMany({}, { $pull: { organizationMemberships: { organizationId: id } } });
};

OrganizationSchema.statics.findOrganizations = async function (user: IUserDoc) {
    const organizationIds = user.organizationMemberships?.map((membership) => membership.organizationId) ?? [];
    return Organization.find({ _id: { $in: organizationIds } });
};

OrganizationSchema.statics.getOrganization = async function (id) {
    return Organization.findById(id);
};

OrganizationSchema.statics.objectForResponse = async function (organization) {
    const object = Object.assign({}, organization.toJSON() as Record<string, any>);
    delete object.deleted;
    return object as IOrganizationJSON;
};

OrganizationSchema.statics.objectForListResponse = async function (organization) {
    const listObject = Object.assign({}, organization.toJSON() as Record<string, any>);
    delete listObject.deleted;
    delete listObject.registeredThemes;
    delete listObject.teams;
    delete listObject.projectGroups;
    return listObject as IOrganizationSimpleJSON;
};

OrganizationSchema.statics.teamForResponse = async function (team) {
    return Object.assign({}, team.toJSON() as unknown as ITeamJSON);
};

OrganizationSchema.statics.userForListResponse = async function (id, user) {
    const teamIds =
        user?.organizationMemberships
            ?.filter((membership) => membership.organizationId.equals(id))?.[0]
            ?.teams?.map((teamId) => teamId.toString()) ?? [];
    return {
        id: user?.id,
        email: user?.email,
        displayName: user?.displayName,
        teamIds
    } as IOrganizationUserSimpleJSON;
};

OrganizationSchema.statics.projectGroupForResponse = async function (projectGroup) {
    const projectGroupInJSON = Object.assign({}, projectGroup.toJSON() as unknown as IProjectGroupJSON);
    return projectGroupInJSON;
};

OrganizationSchema.statics.registeredThemeForResponse = async function (registeredTheme) {
    const registeredThemeInJSON = Object.assign({}, registeredTheme.toJSON() as unknown as IRegisteredThemeJSON);
    return registeredThemeInJSON;
};

OrganizationSchema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: function (_doc: IOrganizationDoc, ret: IOrganizationJSON & Pick<IOrganizationDoc, '_id'>) {
        delete ret._id;
    }
});

const Organization = mongoose.model('Organization', OrganizationSchema.unsafeSchema);
export default Organization;
