import { makeTypeSafeSchema, TypeSafeSchema } from './model-utils';
import mongoose, { Document, Schema, Types } from 'mongoose';
import type { IOrganizationDoc, IOrganizationModel } from './organization.model';
import User from './user.model';
import Organization from './organization.model';
import { ResponseError } from '../services/utils/error.utils';

const TEAM_UPDATABLE_FIELDS = ['name', 'logoPath'] as const;
export type ITeamUpdatableFields = Pick<ITeam, typeof TEAM_UPDATABLE_FIELDS[number]>;

export interface ITeam {
    name: string;
    logoPath?: string;
}

export interface ITeamDoc extends ITeam, Document<Types.ObjectId> {
    id?: string;
}

export type ITeamJSON = ITeam & Pick<ITeamDoc, 'id'>;

export const TeamSchema = makeTypeSafeSchema(
    new Schema<ITeamDoc>({
        name: { type: String, required: true },
        logoPath: { type: String }
    } as Record<keyof ITeam, any>)
);

TeamSchema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: function (_doc: ITeamDoc, ret: ITeamJSON & Pick<ITeamDoc, '_id'>) {
        delete ret._id;
    }
});

// Register team related methods of ISchema
export const registerOrganizationTeamFunctions = (
    OrganizationSchema: TypeSafeSchema<IOrganizationDoc, IOrganizationModel, Types.ObjectId>
): void => {
    OrganizationSchema.methods.getTeams = async function () {
        return this.teams;
    };
    OrganizationSchema.statics.createTeam = async function (id, team) {
        const newTeam = team as ITeamDoc;
        newTeam._id = mongoose.Types.ObjectId();
        return Organization.findOneAndUpdate({ _id: id }, { $addToSet: { teams: newTeam } }, { new: true, runValidators: true });
    };
    OrganizationSchema.statics.updateTeam = async function (id, teamId, team) {
        const newTeamInput = team as Record<string, any>;
        const newTeamFieldSet: Record<string, any> = {};

        TEAM_UPDATABLE_FIELDS.forEach((key) => {
            if (newTeamInput[key]) {
                newTeamFieldSet[`teams.$.${key}`] = newTeamInput[key];
            }
        });
        return Organization.findOneAndUpdate({ _id: id, 'teams._id': teamId }, { $set: newTeamFieldSet }, { new: true });
    };
    OrganizationSchema.statics.deleteTeam = async function (id, teamId) {
        await Organization.findOneAndUpdate({ _id: id, 'teams._id': teamId }, { $pull: { teams: { _id: teamId } } });

        // delete all user membership to this team
        await User.updateMany(
            { 'organizationMemberships.organizationId': id },
            { $pull: { 'organizationMemberships.$[t].teams': teamId } },
            { arrayFilters: [{ 't.organizationId': id }] }
        );
    };

    OrganizationSchema.statics.addUserToTeam = async function (id, teamId, userId) {
        // validate that team exists, as mongoose doesn't validate forign key for inner objects using addToSet
        const organization = await Organization.findOne({ _id: id });
        const organizationTeamFound = organization?.teams?.filter((t) => t._id?.equals(teamId)).length === 1;
        if (!organizationTeamFound) {
            throw new ResponseError('NotFound');
        }

        const user = await User.findOneAndUpdate(
            { _id: userId, 'organizationMemberships.organizationId': id },
            { $addToSet: { 'organizationMemberships.$[t].teams': teamId } },
            { arrayFilters: [{ 't.organizationId': id }] }
        );
        if (!user) {
            // user does not exist or does not member of the organization
            throw new ResponseError('NotFound');
        }
    };

    OrganizationSchema.statics.removeUserFromTeam = async function (id, teamId, userId) {
        // validate that team exists, as mongoose doesn't validate forign key for inner objects using pull
        const organization = await Organization.findOne({ _id: id });
        const organizationTeamFound = organization?.teams?.filter((t) => t._id?.equals(teamId)).length === 1;
        if (!organizationTeamFound) {
            throw new ResponseError('NotFound');
        }

        const user = await User.findOneAndUpdate(
            { _id: userId, 'organizationMemberships.organizationId': id },
            { $pull: { 'organizationMemberships.$[t].teams': teamId } },
            { arrayFilters: [{ 't.organizationId': id }] }
        );
        if (!user) {
            // user does not exist or does not member of the organization
            throw new ResponseError('NotFound');
        }
    };
};
