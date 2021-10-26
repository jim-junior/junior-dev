import crypto from 'crypto';
import _ from 'lodash';
import mongoose, { Model, PassportLocalDocument, Schema, Types } from 'mongoose';
import passportLocalMongoose from 'passport-local-mongoose';
import logger from '../services/logger';
import { docArrayPush, makeTypeSafeSchema } from './model-utils';
import { Writeable, MongooseTimestamps } from '../type-utils';
import Project from './project.model';
import EmailValidation, { IEmailValidation, IEmailValidationDoc } from './email-validation.model';
import analytics from '../services/analytics/analytics';
import { ResponseError } from '../services/utils/error.utils';
import * as userGroupService from '../services/user-group-service/user-group-service';

export interface IConnection {
    type?: string;
    accessToken?: string;
    refreshToken?: string;
    connectionUserId?: string;
    connectionUserEmail?: string;
    settings: any;
}

const ConnectionSchema = new Schema(
    {
        type: {
            type: String,
            enum: [
                'github',
                'github-app',
                'netlify',
                'contentful',
                'forestry',
                'datocms',
                'sanity',
                'devto',
                'google',
                'azure',
                'digitalocean'
            ]
        },
        accessToken: String,
        refreshToken: String,
        connectionUserId: String,
        connectionUserEmail: String,
        settings: {
            type: Schema.Types.Mixed,
            default: {}
        }
    } as Record<keyof IConnection, any>,
    { _id: false }
);

export interface IAuthProvider {
    providerUserId?: string;
    email?: string;
    username?: string;
    displayName?: string;
}

const AuthProviderSchema = new Schema({
    providerUserId: String,
    email: String,
    username: String,
    displayName: String
} as Record<keyof IAuthProvider, any>);

export interface IExclusivePlatform {
    type?: string;
}

const ExclusivePlatformSchema = new Schema({
    type: {
        type: String,
        enum: ['digitalocean']
    }
} as Record<keyof IExclusivePlatform, any>);

export interface ISurvey {
    name?: string;
    fields?: any;
    createdAt?: Date;
}

const SurveySchema = new Schema({
    name: { type: String },
    fields: Schema.Types.Mixed,
    createdAt: { type: Date }
} as Record<keyof ISurvey, any>);

export interface IOrganizationMembership {
    organizationId: Types.ObjectId;
    favoriteProjects: Types.ObjectId[];
    teams: Types.ObjectId[];
}

export interface IUser {
    authProviders?: {
        email?: {
            providerUserId?: string;
            email?: string;
            salt?: string;
            hash?: string;
            resetPasswordToken?: string;
            resetPasswordExpires?: Date;
        };
        github?: IAuthProvider;
        google?: IAuthProvider;
        netlify?: IAuthProvider;
        forestry?: IAuthProvider;
        datocms?: IAuthProvider;
        sanity?: IAuthProvider;
        contentful?: IAuthProvider;
        devto?: IAuthProvider;
    };
    organizationMemberships?: IOrganizationMembership[];
    group?: {
        groupId?: string;
        groupOverrides?: userGroupService.ISchema;
    };
    analytics?: {
        initial_referrer?: string;
        initial_referrer_landing?: string;
        initial_traffic_source?: string;
    };
    connections: IConnection[];
    email?: string;
    displayName?: string;

    /**
     * The temporary user feature has been removed, however, for cleanup purposes this 
     * has been left in the schema to support clearTemporaryUsers()
     */
    temporary: boolean;

    widgetAuthToken?: string;
    emailVerification?: string;
    unverifiedEmail?: string;
    preferences?: {
        dashboardLinksHintDismissed?: boolean;
        exclusivePlatforms?: IExclusivePlatform[];
    };
    tosVersion?: Map<string, boolean>;
    roles?: string[];
    stripeCustomerId?: string;
    surveys: ISurvey[];
}

export interface IUserDoc extends IUser, PassportLocalDocument<Types.ObjectId>, MongooseTimestamps {
    id?: string;

    // sometimes added in runtime
    projectTiers?: string[];

    // virtuals
    readonly features: userGroupService.ISchema;
    readonly authProvider: string;
    readonly githubUsername: string | undefined;
    readonly netlifyAccessToken: string | undefined;
    readonly githubAccessToken: string | undefined;
    readonly contentfulAccessToken: string | undefined;

    // methods
    safeToJSON(): IUserJSON;
    createResetPasswordToken(): Promise<string>;
    setGroup(groupId: string): Promise<IUserDoc>;
    updatePreferences(preferences: IUser['preferences']): Promise<IUserDoc>;
    addGenericAuthProvider(type: string, providerUserId: string, profile: GenericAuthProviderProfile): Promise<IUserDoc>;
    addConnection(provider: string, data: Partial<IConnection>): Promise<IUserDoc>;
    setConnectionId(provider: string, id: string): Promise<IUserDoc>;
    getConnectionByType(connectionType: string): IConnection | undefined;
    removeConnection(provider: string): Promise<IUserDoc>;
    agreeToTosVersion(version: string): Promise<IUserDoc>;
    deleteUserAndContent(): Promise<void>;
    getRoles(): Promise<string[]>;
    setEmailVerificationStatus(status: string, validation: IEmailValidation): Promise<IUserDoc>;
    setUserInitialReferrer(initialReferrer: NonNullable<IUser['analytics']>): Promise<IUserDoc>;
    setStripeCustomerId(id: string): Promise<IUserDoc>;
}

export type IUserJSON = Writeable<Omit<IUser, 'authProviders'>> &
    MongooseTimestamps &
    Writeable<Pick<IUserDoc, '_id' | 'id' | 'authProvider' | 'githubUsername' | 'features' | 'projectTiers'>>;

export type IUserSimpleJSON = Pick<IUserDoc, '_id' | 'id' | 'authProvider' | 'githubUsername' | 'features' | 'projectTiers'>;

export interface IUserModel extends Model<IUserDoc> {
    // statics
    resetPassword(resetPasswordToken: string, newPassword: string): Promise<IUserDoc>;
    createUser(user?: Partial<IUser>): Promise<IUserDoc>;
    deleteUserById(userId: Types.ObjectId): Promise<void>;
    findUserByEmail(email: string): Promise<IUserDoc | null>;
    findUserByCustomerId(customerId: string): Promise<IUserDoc | null>;
    findUserByProviderId(provider: string, id: string): Promise<IUserDoc | null>;
    findUserByConnectionId(provider: string, id: string): Promise<IUserDoc | null>;
    findUserById(id: Types.ObjectId): Promise<IUserDoc | null>;
    findUsersById(ids: Types.ObjectId[]): Promise<IUserDoc[]>;
    findUserByIdWithRoles(id: Types.ObjectId): Promise<IUserDoc | null>;
    clearTemporaryUsers(): Promise<void>;
    addEmailAuthProvider(validation: IEmailValidationDoc): Promise<IUserDoc | null>;
    findNetlifyUsersToMigrate(limit: number | string): Promise<IUserDoc[]>;
    findUserByWidgetAuthToken(token: string): Promise<IUserDoc | null>;
    addSurvey(userId: Types.ObjectId, survey: ISurvey, overwrite?: boolean): Promise<ISurvey>;
    addProjectToFavorites(userId: Types.ObjectId, projectId: Types.ObjectId): Promise<void>;
    removeProjectFromFavorites(userId: Types.ObjectId, projectId: Types.ObjectId): Promise<void>;
}

const UserSchema = makeTypeSafeSchema(
    new Schema<IUserDoc, IUserModel>(
        {
            authProviders: {
                type: {
                    email: {
                        providerUserId: String,
                        email: String,
                        salt: { type: String, select: false },
                        hash: { type: String, select: false },
                        resetPasswordToken: { type: String, select: false },
                        resetPasswordExpires: { type: Date, select: false }
                    },
                    github: AuthProviderSchema,
                    google: AuthProviderSchema,
                    netlify: AuthProviderSchema,
                    forestry: AuthProviderSchema,
                    datocms: AuthProviderSchema,
                    sanity: AuthProviderSchema,
                    contentful: AuthProviderSchema,
                    devto: AuthProviderSchema
                }
            },
            organizationMemberships: [
                {
                    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
                    favoriteProjects: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Project' }],
                    teams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }]
                }
            ],
            analytics: {
                initial_referrer: String,
                initial_referrer_landing: String,
                initial_traffic_source: String
            },
            connections: [ConnectionSchema],
            email: String,
            displayName: String,
            temporary: { type: Boolean, default: false },
            widgetAuthToken: String,
            emailVerification: String,
            unverifiedEmail: String,
            preferences: {
                dashboardLinksHintDismissed: { type: Boolean, default: false },
                exclusivePlatforms: [ExclusivePlatformSchema]
            },
            tosVersion: {
                type: Map,
                of: Boolean
            },
            roles: {
                type: [{ type: String, enum: ['user', 'admin'] }],
                select: false,
                default: ['user'],
                required: true
            },
            stripeCustomerId: String,
            surveys: [SurveySchema],
            group: {
                // The ID of the tier, matching one of the tiers defined in the API config (e.g. regular)
                groupId: String,

                // A hash of feature overrides, taking precedence over the features defined for the group
                groupOverrides: userGroupService.SCHEMA
            }
        } as Record<keyof IUser, any>,
        {
            timestamps: true,
            toJSON: {
                transform: function (doc: IUserDoc, ret: IUserJSON & IUser) {
                    ret.id = ret._id?.toString();
                    ret.authProvider = doc.authProvider;
                    ret.githubUsername = doc.githubUsername;
                    delete ret.authProviders;
                    ret.features = doc.features;
                    ret.projectTiers = doc.projectTiers;
                }
            }
        }
    )
);

UserSchema.methods.safeToJSON = function () {
    return this.toJSON() as unknown as IUserJSON;
};

UserSchema.typeSafeVirtual('features', function () {
    const groupId = this.group?.groupId ?? userGroupService.DEFAULT_GROUP_ID;
    const overrides = this.group?.groupOverrides;
    return userGroupService.getGroupFeatures(groupId, overrides);
});

UserSchema.typeSafeVirtual('authProvider', function () {
    return Object.keys(this.authProviders ?? {})[0] ?? 'email';
});

UserSchema.typeSafeVirtual('githubUsername', function () {
    const { authProviders = {} } = this;
    if (authProviders && authProviders.github) {
        return authProviders.github.username;
    }
});

UserSchema.typeSafeVirtual('netlifyAccessToken', function () {
    const con = this.connections.find((con) => con.type === 'netlify');
    return con?.accessToken;
});

UserSchema.typeSafeVirtual('githubAccessToken', function () {
    const conType = 'github-app';
    const con = this.connections.find((con) => con.type === conType);
    return con?.accessToken;
});

UserSchema.typeSafeVirtual('contentfulAccessToken', function () {
    const con = this.connections.find((con) => con.type === 'contentful');
    return con?.accessToken;
});

UserSchema.index({ 'authProviders.email.providerUserId': 1 }, { unique: true, sparse: true });
UserSchema.index({ 'authProviders.github.providerUserId': 1 }, { unique: true, sparse: true });
UserSchema.index({ 'authProviders.google.providerUserId': 1 }, { unique: true, sparse: true });
UserSchema.index({ 'authProviders.netlify.providerUserId': 1 }, { unique: true, sparse: true });
UserSchema.index({ stripeCustomerId: 1 }, { unique: true, sparse: true });
UserSchema.index({ widgetAuthToken: 1 }, { sparse: true });
UserSchema.index({ createdAt: -1 });

/*
 *  User Model Methods
 */
UserSchema.methods.createResetPasswordToken = async function () {
    const resetPasswordToken = await new Promise<string>((resolve, reject) => {
        crypto.randomBytes(20, function (err, buf) {
            if (err) {
                return reject(err);
            }

            const token = buf.toString('hex');
            resolve(token);
        });
    });
    await this.update({
        'authProviders.email.resetPasswordToken': resetPasswordToken,
        'authProviders.email.resetPasswordExpires': new Date(Date.now() + 3600000) // 1 hour
    });
    return resetPasswordToken;
};

UserSchema.statics.resetPassword = async function (resetPasswordToken, newPassword) {
    const user = await User.findOne({
        'authProviders.email.resetPasswordToken': resetPasswordToken,
        'authProviders.email.resetPasswordExpires': {
            $gte: new Date()
        }
    });
    if (!user) {
        throw { name: 'TokenExpired', message: 'Reset token has expired.' };
    }
    await user.setPassword(newPassword);
    await user.update({
        'authProviders.email.resetPasswordToken': null,
        'authProviders.email.resetPasswordExpires': null
    });
    return user.save();
};

UserSchema.statics.createUser = async function (user = {}) {
    user.widgetAuthToken = crypto.randomBytes(32).toString('hex');
    const dbUser = await new User(user).save();
    const { id } = dbUser;
    const log = { userId: id };
    logger.debug(`[createUser] user created ${log.userId}`, log);
    return dbUser;
};

UserSchema.statics.deleteUserById = async function (userId) {
    await User.deleteOne({ _id: userId });
    logger.debug(`[deleteUserById] deleted userId: ${userId}`);
    await analytics.deleteAndSuppressUser(userId, 'Delete');
};

UserSchema.statics.findUserByEmail = async function (email) {
    if (!email) {
        return null;
    }
    return User.findOne({ email: email });
};

UserSchema.statics.findUserByCustomerId = async function (customerId) {
    if (!customerId) {
        return null;
    }
    return User.findOne({ stripeCustomerId: customerId });
};

UserSchema.statics.findUserByProviderId = async function (provider, id) {
    if (!id) {
        return null;
    }
    return User.findOne({ [`authProviders.${provider}.providerUserId`]: id });
};

UserSchema.statics.findUserByConnectionId = async function (provider, id) {
    return User.findOne({
        connections: {
            $elemMatch: {
                type: provider,
                connectionUserId: id
            }
        }
    });
};

UserSchema.statics.findUserById = async function (id) {
    return User.findOne({ _id: id });
};

UserSchema.statics.findUsersById = async function (ids) {
    return User.find({ _id: { $in: ids } });
};

UserSchema.statics.findUserByIdWithRoles = async function (id) {
    return User.findOne({ _id: id }, '+roles');
};

/**
 * The temporary users feature has been removed. This method was left to allow for system cleanup
 */
UserSchema.statics.clearTemporaryUsers = async function () {
    const time = new Date();
    time.setMonth(time.getMonth() - 1);
    const users = await User.find({ temporary: true, createdAt: { $lt: time } });
    const userIds = users.map((user) => user._id!);
    const deletedProjects = await Project.deleteProjectsByOwnerIds(userIds);
    if (deletedProjects.n > 0) {
        logger.debug('deleted temporary projects', { projects: deletedProjects });
    }
    const deletedUsers = await User.deleteMany({ _id: { $in: userIds } });
    if (deletedUsers.n > 0) {
        logger.debug('deleted temporary users', { users: deletedUsers });
        await analytics.deleteAndSuppressUser(userIds, 'Delete');
    }
};

UserSchema.statics.addEmailAuthProvider = async function (validation) {
    logger.debug(`[addEmailAuthProvider] adding email auth provider to userId: ${validation.userId}`);
    const user = (await User.findOne({ _id: validation.userId }))!;
    const existingUser = await User.findOne({ email: validation.email });

    logger.debug('[addEmailAuthProvider] user', { userId: user.id, email: validation.email });
    logger.debug(`[addEmailAuthProvider] existingUser existingUserId: ${existingUser?.id}, email: ${existingUser?.email}`);

    const data = {
        temporary: false,
        email: user.email ? user.email : validation.email,
        emailVerification: 'verified',
        'authProviders.email': {
            salt: validation.salt,
            hash: validation.hash,
            providerUserId: validation.email,
            email: validation.email
        }
    };
    logger.debug('[addEmailAuthProvider] updating temporary user');
    const updatedUser = await User.findOneAndUpdate({ _id: user.id }, data, { new: true });
    await EmailValidation.deleteEmailValidationById(validation._id!);
    logger.debug(`[addEmailAuthProvider] user saved! ${updatedUser?.id}`);
    return updatedUser;
};

UserSchema.methods.setGroup = async function (groupId) {
    const group = userGroupService.getById(groupId);
    if (!group) {
        return this;
    }
    this.group = { groupId };
    return this.save();
};

UserSchema.methods.updatePreferences = function (preferences: IUser['preferences']) {
    preferences = preferences || {};
    this.preferences = this.preferences || {};

    if (preferences.dashboardLinksHintDismissed !== undefined) {
        this.preferences.dashboardLinksHintDismissed = preferences.dashboardLinksHintDismissed;
    }

    if (preferences.exclusivePlatforms !== undefined) {
        this.preferences.exclusivePlatforms = _.values(
            _.merge(_.keyBy(this.preferences.exclusivePlatforms ?? [], 'type'), _.keyBy(preferences.exclusivePlatforms, 'type'))
        );
    }

    return this.save();
};

interface GenericAuthProviderProfile {
    username?: string;
    displayName?: string;
    emails?: {
        primary?: boolean;
        value?: string;
        [k: string]: any;
    }[];
    _json?: {
        slug?: string;
        [k: string]: any;
    };
    [k: string]: any;
}

UserSchema.methods.addGenericAuthProvider = async function (type, providerUserId, profile) {
    const emails = profile.emails ?? [];
    const primaryEmail = emails.find((email) => email.primary)?.value || emails[0]?.value;
    const username = type === 'netlify' ? profile._json?.slug : profile.username;
    const displayName = profile.displayName || username;

    if (!this.email && primaryEmail) {
        this.email = primaryEmail;
    }

    if (!this.displayName && displayName) {
        this.displayName = displayName;
    }

    const user = await this.save();
    const auth: Partial<IAuthProvider> = {
        providerUserId,
        username: username,
        displayName,
        email: primaryEmail
    };
    await this.update({
        [`authProviders.${type}`]: auth
    });
    return user;
};

UserSchema.statics.findNetlifyUsersToMigrate = async function (limit) {
    return User.find(
        {
            connections: {
                $elemMatch: {
                    type: 'netlify',
                    connectionUserId: { $exists: false }
                }
            }
        },
        null,
        { limit: typeof limit === 'number' ? limit : parseInt(limit, 10) }
    );
};

UserSchema.methods.addConnection = function (provider, data) {
    const connection = this.connections.find((con: IConnection) => con.type === provider);

    if (connection) {
        if (data.refreshToken) {
            connection.refreshToken = data.refreshToken;
        }
        if (data.accessToken) {
            connection.accessToken = data.accessToken;
        }
        if (data.connectionUserId) {
            connection.connectionUserId = data.connectionUserId;
        }
        if (data.connectionUserEmail) {
            connection.connectionUserEmail = data.connectionUserEmail;
        }
        if (data.settings) {
            _.assign(connection.settings, data.settings);
        }
    } else {
        const con: Partial<IConnection> = {
            type: provider,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            connectionUserId: data.connectionUserId,
            connectionUserEmail: data.connectionUserEmail,
            settings: data.settings
        };
        docArrayPush(this, 'connections', con);
    }

    this.markModified('connections');

    return this.save();
};

UserSchema.methods.setConnectionId = function (provider, id) {
    const connection = this.connections.find((con) => con.type === provider);
    if (connection) {
        connection.connectionUserId = id;
    }
    return this.save();
};

UserSchema.methods.getConnectionByType = function (connectionType) {
    return _.find(this.connections, { type: connectionType });
};

UserSchema.methods.removeConnection = async function (provider) {
    const connectionIndex = this.connections.findIndex((con) => con.type === provider);

    if (connectionIndex > -1) {
        this.connections.splice(connectionIndex, 1);
        return this.save();
    }
    return this;
};

UserSchema.methods.agreeToTosVersion = async function (version) {
    if (version) {
        version = version.replace(/\./g, '_');
        this.set(`tosVersion.${version}`, true);
        return this.save();
    }

    return this;
};

UserSchema.methods.deleteUserAndContent = async function () {
    await this.remove();
    await Project.deleteProjectsByOwner(this._id!);
    await analytics.deleteAndSuppressUser(this._id!, 'Suppress_With_Delete');
};

UserSchema.methods.getRoles = async function () {
    if (this.roles) {
        return this.roles;
    }
    const userWithRoles = (await User.findOne({ _id: this._id }, '+roles'))!;
    return userWithRoles.roles!;
};

UserSchema.statics.findUserByWidgetAuthToken = async function (token) {
    return User.findOne({ widgetAuthToken: token });
};

UserSchema.methods.setEmailVerificationStatus = function (status, validation) {
    this.emailVerification = status;
    if (validation) {
        this.unverifiedEmail = validation.email;
    }
    return this.save();
};

UserSchema.methods.setUserInitialReferrer = function (initialReferrer) {
    _.set(this, 'analytics.initial_referrer', initialReferrer.initial_referrer);
    _.set(this, 'analytics.initial_referrer_landing', initialReferrer.initial_referrer_landing);
    _.set(this, 'analytics.initial_traffic_source', initialReferrer.initial_traffic_source);
    return this.save();
};

UserSchema.methods.setStripeCustomerId = function (id) {
    this.stripeCustomerId = id;
    return this.save();
};

UserSchema.statics.addSurvey = async function (userId, survey, overwrite = false) {
    const user = (await User.findOne({ _id: userId }))!;
    const existingSurvey = user.surveys.find((userSurvey) => {
        return userSurvey.name === survey.name;
    });
    if (overwrite && existingSurvey) {
        const existingSurveyIndex = user.surveys.findIndex((userSurvey) => {
            return userSurvey.name === survey.name;
        });
        survey.createdAt = new Date();
        user.surveys[existingSurveyIndex] = survey;
        await user.save();
        return survey;
    }
    if (existingSurvey) {
        throw new ResponseError('SurveyAlreadyCompleted');
    } else {
        survey.createdAt = new Date();
        user.surveys.push(survey);
        await user.save();
        return survey;
    }
};

UserSchema.statics.addProjectToFavorites = async function (projectId, userId) {
    const orgId = (await Project.findOne({ _id: projectId }))?.organizationId;
    if (!orgId) {
        throw new ResponseError('NotFound');
    }
    const updatedUser = await User.findOneAndUpdate(
        { _id: userId, 'organizationMemberships.organizationId': orgId },
        { $addToSet: { 'organizationMemberships.$[t].favoriteProjects': projectId } },
        { arrayFilters: [{ 't.organizationId': orgId }] }
    );
    if (!updatedUser) {
        // user or organization doesn't exist
        throw new ResponseError('NotFound');
    }
};

UserSchema.statics.removeProjectFromFavorites = async function (projectId, userId) {
    const orgId = (await Project.findOne({ _id: projectId }))?.organizationId;
    if (!orgId) {
        throw new ResponseError('NotFound');
    }
    const updatedUser = await User.findOneAndUpdate(
        { _id: userId, 'organizationMemberships.organizationId': orgId },
        { $pull: { 'organizationMemberships.$[t].favoriteProjects': projectId } },
        { arrayFilters: [{ 't.organizationId': orgId }] }
    );
    if (!updatedUser) {
        // user or organization doesn't exist
        throw new ResponseError('NotFound');
    }
};

// https://github.com/saintedlama/passport-local-mongoose#options
const userOptions = {
    // usernameField: this option is shared between passport-local and passport-mongoose-local.
    // It defines both which req.body param to compare and which mongo user field to compare too.
    // It must be email because req.body.email
    usernameField: 'email',
    // usernameQueryFields: this option is because usernameField is email but our actual mongo model is authProviders...
    // We can't change that without changing req.body for every login request
    usernameQueryFields: ['authProviders.email.providerUserId'],
    saltField: 'authProviders.email.salt',
    hashField: 'authProviders.email.hash',
    usernameLowerCase: true,
    usernameUnique: false // we set our own indexes.
};

UserSchema.plugin(passportLocalMongoose, userOptions);

const User = mongoose.model('User', UserSchema.unsafeSchema);
export default User;
