import mongoose, { Document, Schema, Types } from 'mongoose';
import { makeTypeSafeSchema, TypeSafeSchema } from './model-utils';
import Organization, { IOrganization, IOrganizationDoc, IOrganizationModel } from './organization.model';
import { PROJECT_GROUPS_IDS_KEY } from './project.model';
import Project from './project.model';

export interface IProjectGroup {
    name?: string;
}

const PROJECT_GROUP_UPDATABLE_FIELDS = ['name'] as const;
export type IProjectGroupUpdatable = Pick<IProjectGroup, typeof PROJECT_GROUP_UPDATABLE_FIELDS[number]>; // whitelist updatable fields

export interface IProjectGroupDoc extends IProjectGroup, Document<Types.ObjectId> {
    id?: string;
}

export type IProjectGroupJSON = IProjectGroup & Pick<IProjectGroupDoc, 'id'>;

export const ProjectGroupSchema = makeTypeSafeSchema(
    new Schema<IProjectGroupDoc>({
        name: String
    } as Record<keyof IProjectGroup, any>)
);

ProjectGroupSchema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: function (_doc: IProjectGroupDoc, ret: IProjectGroupJSON & Pick<IProjectGroupDoc, '_id'>) {
        delete ret._id;
    }
});

export type ProjectGroupsKeyType = Pick<IOrganization, 'projectGroups'>;
const PROJECT_GROUPS_KEY: keyof ProjectGroupsKeyType = 'projectGroups';

// Register projectGroup related methods of OrganizationSchema
export const registerOrganizationProjectGroupMethods = (
    OrganizationSchema: TypeSafeSchema<IOrganizationDoc, IOrganizationModel, Types.ObjectId>
): void => {
    OrganizationSchema.methods.getProjectGroups = async function () {
        return this[PROJECT_GROUPS_KEY];
    };
    OrganizationSchema.statics.createProjectGroup = async function (orgId, projectGroup) {
        const newProjectGroup = projectGroup as IProjectGroupDoc;
        newProjectGroup._id = mongoose.Types.ObjectId();
        return await Organization.findOneAndUpdate(
            { _id: orgId },
            { $addToSet: { [PROJECT_GROUPS_KEY]: newProjectGroup } },
            { new: true, runValidators: true }
        );
    };
    OrganizationSchema.statics.updateProjectGroup = async function (orgId, projectGroupId, projectGroup) {
        const currentProjectGroup = projectGroup as IProjectGroupDoc;
        const newProjectGroup = {} as Record<string, any>;
        PROJECT_GROUP_UPDATABLE_FIELDS.forEach((key) => {
            if (currentProjectGroup[key]) {
                newProjectGroup[`${PROJECT_GROUPS_KEY}.$.${key}`] = currentProjectGroup[key];
            }
        });
        return await Organization.findOneAndUpdate(
            { _id: orgId, [`${PROJECT_GROUPS_KEY}._id`]: projectGroupId },
            { $set: newProjectGroup },
            { new: true }
        );
    };
    OrganizationSchema.statics.deleteProjectGroup = async function (orgId, projectGroupId) {
        // delete all project relationships to deleted project group
        await Project.updateMany({ [PROJECT_GROUPS_IDS_KEY]: projectGroupId }, { $pull: { [PROJECT_GROUPS_IDS_KEY]: projectGroupId } });

        await Organization.findOneAndUpdate(
            { _id: orgId, [`${PROJECT_GROUPS_KEY}._id`]: projectGroupId },
            { $pull: { [PROJECT_GROUPS_KEY]: { _id: projectGroupId } } }
        );
    };
};
