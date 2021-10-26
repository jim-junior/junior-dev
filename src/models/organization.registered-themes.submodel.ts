import { makeTypeSafeSchema, TypeSafeSchema } from './model-utils';
import mongoose, { Document, Schema, Types } from 'mongoose';
import type { IOrganization, IOrganizationDoc, IOrganizationModel } from './organization.model';
import Organization from './organization.model';

const REGISTERED_THEME_UPDATABLE_FIELDS = ['name', 'repoUrl', 'thumbnailUrl', 'description', 'ssg', 'cms', 'isMultiSite'] as const;
export type IRegisteredThemeUpdatableFields = Pick<IRegisteredTheme, typeof REGISTERED_THEME_UPDATABLE_FIELDS[number]>;

export interface IRegisteredTheme {
    name: string;
    repoUrl: string;
    thumbnailUrl?: string;
    description?: string;
    ssg?: string;
    cms?: string;
    isMultiSite?: boolean;
}

export interface IRegisteredThemeDoc extends IRegisteredTheme, Document<Types.ObjectId> {
    id?: string;
}

export type IRegisteredThemeJSON = IRegisteredTheme & Pick<IRegisteredThemeDoc, 'id'>;

export const RegisteredThemeSchema = makeTypeSafeSchema(
    new Schema<IRegisteredThemeDoc>({
        name: { type: String, required: true },
        repoUrl: { type: String, required: true },
        thumbnailUrl: { type: String },
        description: { type: String },
        ssg: { type: String, enum: ['gatsby', 'next'] },
        cms: { type: String, enum: ['contentful', 'git'] },
        isMultiSite: { type: Boolean },
    } as Record<keyof IRegisteredTheme, any>)
);

RegisteredThemeSchema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: function (_doc: IRegisteredThemeDoc, ret: IRegisteredThemeJSON & Pick<IRegisteredThemeDoc, '_id'>) {
        delete ret._id;
    }
});

export type RegisteredThemesKeyType = Pick<IOrganization, 'registeredThemes'>;
const REGISTERED_THEMES_KEY: keyof RegisteredThemesKeyType = 'registeredThemes';

// Register registered theme related methods of ISchema
export const registerOrganizationRegisteredThemeFunctions = (
    OrganizationSchema: TypeSafeSchema<IOrganizationDoc, IOrganizationModel, Types.ObjectId>
): void => {
    OrganizationSchema.methods.getRegisteredThemes = async function () {
        return this[REGISTERED_THEMES_KEY];
    };
    OrganizationSchema.statics.createRegisteredTheme = async function (orgId, registeredTheme) {
        const newRegisteredTheme = registeredTheme as IRegisteredThemeDoc;
        newRegisteredTheme._id = mongoose.Types.ObjectId();
        return Organization.findOneAndUpdate(
            { _id: orgId },
            { $addToSet: { [REGISTERED_THEMES_KEY]: newRegisteredTheme } },
            { new: true, runValidators: true }
        );
    };
    OrganizationSchema.statics.updateRegisteredTheme = async function (orgId, registeredThemeId, registeredTheme) {
        const currentRegisteredTheme = registeredTheme as IRegisteredThemeDoc;
        const newRegisteredTheme = {} as Record<string, any>;
        REGISTERED_THEME_UPDATABLE_FIELDS.forEach((key) => {
            if (currentRegisteredTheme[key]) {
                newRegisteredTheme[`${REGISTERED_THEMES_KEY}.$.${key}`] = currentRegisteredTheme[key];
            }
        });
        return await Organization.findOneAndUpdate(
            { _id: orgId, [`${REGISTERED_THEMES_KEY}._id`]: registeredThemeId },
            { $set: newRegisteredTheme },
            { new: true }
        );
    };
    OrganizationSchema.statics.deleteRegisteredTheme = async function (orgId, registeredThemeId) {
        await Organization.findOneAndUpdate(
            { _id: orgId, [`${REGISTERED_THEMES_KEY}._id`]: registeredThemeId },
            { $pull: { [REGISTERED_THEMES_KEY]: { _id: registeredThemeId } } }
        );
    };
};
