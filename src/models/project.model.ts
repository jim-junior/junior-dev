import crypto from 'crypto';
import _ from 'lodash';
import mongoose, { Document, Model, Schema, Types, Query } from 'mongoose';
import { Writeable, MongooseTimestamps } from '../type-utils';
import * as customerTierService from '../services/customer-tier-service/customer-tier-service';
import { sendPlansEmail, PLANS_EMAIL_EVENT } from '../services/customerio-service/customerio-transactional-service';
import { v4 as uuid } from 'uuid';
import { URL } from 'url';
import config from '../config';
import logger from '../services/logger';
import analytics from '../services/analytics/analytics';
import { ResponseError } from '../services/utils/error.utils';
import * as nameGenerator from '@stackbit/artisanal-names';
import projectUtils from '../services/project-services/project-utils';
import { makeSetUnsetUpdateObj, makeTypeSafeSchema } from './model-utils';
import type { IUserDoc, IUserModel } from './user.model';
import CollaboratorRole, { CollaboratorRoleSettings, Permission } from './collaborator-role.model';
import mongoose_delete, { SoftDeleteModel } from 'mongoose-delete';
import omitDeep from 'omit-deep-lodash';
import { calculateProjectScore } from '../services/utils/score-utils';
import { createMongooseQuery, SortedPagesParams } from '../services/utils/sortedpages.utils';
import Organization from './organization.model';

const SUBSCRIPTION_FLAGS = ['trialExpiredRecently', 'paidPlanExpiredRecently', 'trialStartedRecently'];
const DEFAULT_LIST_SORT_BY = 'createdAt';
const DEFAULT_LIST_SORT_DIRECTION = -1;
const DEFAULT_LIST_PAGE_SIZE = 10;

export interface IImportData {
    dataType: 'medium' | 'devto' | 'googledocs' | 'jobox' | 'netlify' | null;
    urlKey?: string;
    filePath?: string;
    importedPath?: string;
    dataContextPath?: string;
    settings: any;
}

const ImportDataSchema: Record<keyof IImportData, any> = {
    dataType: {
        type: String,
        enum: ['medium', 'devto', 'googledocs', 'jobox', 'netlify'],
        default: null
    },
    urlKey: String,
    filePath: String,
    importedPath: String,
    dataContextPath: String,
    settings: {
        type: Schema.Types.Mixed,
        default: {}
    }
};

export interface IWidget {
    netlifyInject: boolean;
    flatTree: boolean;
    realtimeEditor: boolean;
    reloadSchemaWithFields: boolean;
    hmrReload: boolean;
    branchInfoEnabled: boolean;
    slateRichTextEnabled: boolean;
    codeEditorEnabled?: boolean;
    codeEditorActionsEnabled?: boolean;
    schemaEditorEnabled: boolean;
}

const WidgetSchema: Record<keyof IWidget, any> = {
    netlifyInject: { type: Boolean, default: false },
    flatTree: { type: Boolean, default: true },
    realtimeEditor: { type: Boolean, default: false },
    reloadSchemaWithFields: { type: Boolean, default: false },
    hmrReload: { type: Boolean, default: false },
    branchInfoEnabled: { type: Boolean, default: false },
    slateRichTextEnabled: { type: Boolean, default: false },
    codeEditorEnabled: { type: Boolean },
    codeEditorActionsEnabled: { type: Boolean },
    schemaEditorEnabled: { type: Boolean, default: true }
};

export interface ILayer {
    id?: string;
    title?: string;
    settings: any;
}

const LayerSchema: Record<keyof ILayer, any> = {
    id: String,
    title: String,
    settings: {
        type: Schema.Types.Mixed,
        default: {}
    }
};

export interface ISettings {
    autoBuildTriggerEnabled: boolean;
    autoTransferRepoEnabled: boolean;
    hasStackbitPull?: boolean;
    studioEditRequestTimeout: number;
    isGenericContainer: boolean;
    localContainerMode?: boolean;
}

const SettingsSchema: Record<keyof ISettings, any> = {
    autoBuildTriggerEnabled: { type: Boolean, default: true },
    autoTransferRepoEnabled: { type: Boolean, default: false },
    hasStackbitPull: { type: Boolean },

    // time after which edit request from studio will be marked as completed - prevent request sticking
    studioEditRequestTimeout: { type: Number, default: 15 },

    // This flag makes the orchestration service use the generic container
    // task definition, as opposed to a theme+SSG+CMS combo task.
    isGenericContainer: { type: Boolean, default: false },

    // This flag forces the preview container to run in local mode (or shared mode if value is false).
    // The default value is set in config.json by environment in config.features.localContainerMode.
    localContainerMode: { type: Boolean }
};

export interface ICollaborator {
    inviteToken?: string;
    inviteEmail?: string;
    userId?: Types.ObjectId;
    role?: string;
    notifications: ICollaboratorNotification[];
}

export interface ICollaboratorNotification {
    type: string;
    lastSentAt: Date;
    subscribed?: boolean;
}

export interface ICollaboratorDoc extends ICollaborator, Document<Types.ObjectId> {
    id?: string;

    // virtuals
    readonly status: 'collaborator' | 'invitation-sent';
    readonly roleOrDefault: CollaboratorRole;
}

export type ProjectListFilterParams = {
    namePart?: string;
    themeId?: string;
};

export type ICollaboratorJSON = ICollaborator & Pick<ICollaboratorDoc, 'id' | 'status' | 'roleOrDefault'>;

// This value is returned by project.routes.js's getCollaborators.
export interface ICollaboratorExtendedJSON {
    id: string;
    userId: string;
    email?: string;
    role: string;
    invitationRole?: string;
}

const CollaboratorNotificationSchema: Record<keyof ICollaboratorNotification, any> = {
    type: {
        type: String,
        enum: ['projectPublished']
    },
    lastSentAt: Date,
    subscribed: Boolean
};

const CollaboratorSchema = makeTypeSafeSchema(
    new Schema<ICollaboratorDoc>({
        inviteToken: String,
        inviteEmail: String,
        userId: { type: Schema.Types.ObjectId, ref: 'User' },
        role: String,
        notifications: [CollaboratorNotificationSchema]
    } as Record<keyof ICollaborator, any>)
);

CollaboratorSchema.typeSafeVirtual('status', function () {
    if (this.userId) {
        return 'collaborator';
    } else {
        return 'invitation-sent';
    }
});

CollaboratorSchema.typeSafeVirtual('roleOrDefault', function () {
    if (this.role) {
        const roleFromName = CollaboratorRole.fromName(this.role);
        if (!roleFromName) {
            logger.warn(`[roleOrDefault] Unknown role name: ${this.role}`);
        }
        return roleFromName ?? CollaboratorRole.NONE;
    } else {
        return CollaboratorRole.DEFAULT_COLLABORATOR_ROLE;
    }
});

export interface ISplitTest {
    name?: string;
    netlifySplitTestId?: string;
    status: 'provisioned' | 'starting' | 'running' | 'finishing' | 'failed' | null;
    analytics: any;
    hasChanges?: boolean;
    variants?: {
        name?: string;
        split?: number;
        environment?: string;
    }[];
}

export interface ISplitTestSimpleJSON {
    name?: string;
    netlifySplitTestId?: string;
    status: 'provisioned' | 'starting' | 'running' | 'finishing' | 'failed' | null;
    analytics: any;
    hasChanges?: boolean;
    variants?: {
        name?: string;
        split?: number;
        environment?: string;
        netlifyStatus?: string;
        containerStatus?: string;
        containerHealthy?: boolean;
    }[];
}

const SplitTestSchema: Record<keyof ISplitTest, any> = {
    name: String,
    netlifySplitTestId: String,
    status: {
        type: String,
        enum: ['provisioned', 'starting', 'running', 'finishing', 'failed'],
        default: null
    },
    analytics: {
        type: Schema.Types.Mixed,
        default: {}
    },
    hasChanges: Boolean,
    variants: [
        {
            name: String,
            split: Number,
            environment: String
        }
    ]
};

export interface IWebhooks {
    github?: {
        repoName: string;
    };
}

const WebhooksSchema: Record<keyof IWebhooks, any> = {
    github: {
        repoName: String
    }
};

export interface IProject {
    name?: string;
    ownerId?: Types.ObjectId;
    organizationId?: Types.ObjectId;
    projectGroupIds?: Types.ObjectId[];
    thumbUrl?: string;
    largeThumbUrl?: string;
    wizard?: {
        settings: any;
        theme?: ILayer;
        ssg?: ILayer;
        cms?: ILayer;
        repository?: ILayer;
        deployment?: ILayer;
        container?: ILayer;
    };
    siteUrl?: string;
    allowedHosts?: string[];
    deploymentData: any;
    environments: any;
    splitTests: ISplitTest[];
    settings: ISettings;
    buildStatus: string;
    buildMessage?: string;
    deployedAt?: Date;
    APIKeys?: { name?: string; key?: string }[];
    importData: IImportData;
    widget: IWidget;
    metrics: {
        deployCount: number;
        deploySuccessCount: number;
        didChangeNetlifyName: boolean;
        didChangeGithubName: boolean;
        buildStartTime: number;
        buildDuration: number;
        dailyVisitsDate?: Date;
        dailyVisits: number;
        monthlyVisits: number;
        buildDurationToFirstLive: number;
        hasDeveloperCommits: boolean;
        developerCommitCount: number;
        lastDeveloperCommitAt?: Date;
        realScore?: {
            manualScore: number | null;
            autoScore: number | null;
        };
        studioScore: number;
    };
    alerts: {
        alertId?: string;
        alertType?: string;
        message?: { body?: string; title?: string };
        action?: { title?: string; url?: string };
        alertClassName?: string;
        dismissable?: boolean;
    }[];
    collaborationInviteToken?: string;
    collaborators?: ICollaborator[];
    subscription?: {
        trialExpiredRecently?: string;
        paidPlanExpiredRecently?: string;
        trialStartedRecently?: string;
        endOfBillingCycle?: Date;
        id?: string;
        newSubscriptionTrialDays?: number;
        paymentLinkToken?: string;
        scheduledForCancellation?: boolean;
        tierId?: string;
        tierOverrides?: customerTierService.CustomerTierFeatures;
        pastTierIds: string[];
    };
    classifications: any;
    requestedPublishes: {
        requester?: Types.ObjectId;
        date?: Date;
        text?: string;
    }[];
    previewToken?: string;
    webhooks?: IWebhooks;
}

export interface IProjectDoc extends IProject, Document<Types.ObjectId>, MongooseTimestamps {
    id?: string;

    // references as documents
    collaborators?: ICollaboratorDoc[];

    // virtuals
    readonly availableFeatures: customerTierService.CustomerTierFeatures;
    readonly tier: { isFree: boolean; hooks: any };
    readonly shouldHibernate: boolean;
    readonly containerMaxInactivityTimeInMinutes: number | undefined;
    subscription: {
        safeTierId: string;
        tierName?: string;
        isFree: boolean;
        isTrial: boolean;
        paidTierId?: string;
        paidTierName?: string;
    } & Partial<Omit<NonNullable<IProject['subscription']>, 'pastTierIds'>> &
        Pick<NonNullable<IProject['subscription']>, 'pastTierIds'>;
    readonly classificationGroups: Record<string, string | null>;
    readonly eligibleForTrials: customerTierService.CustomerTierTrialWithEligibility[];
    readonly previewContainerMode: 'shared' | 'local';

    // methods
    getDefaultBranch(): string;
    getContainerBranches(environment?: string | null): { previewBranch: string; publishBranch: string };
    getDeploymentData<T>(path: string, environment?: string | null): T | undefined;
    getDeploymentData<T>(path: string, environment: string | null | undefined, defaultVal: T): T;
    getCollaboratorRole(user: IUserDoc): Promise<CollaboratorRole>;
    isSubscriptionEnded(): Promise<boolean>;
    dismissAlert(alertId: string): Promise<IProjectDoc>;
    hasSubscription(): boolean;
    getUserEnvironment(): Record<string, string | undefined> | undefined;
    getCustomerTier(): { name?: string; features?: customerTierService.CustomerTierFeatures };
    getPaymentLinkTokenOrGenerateNew(): Promise<string>;
    checkTierAllowanceForFeature(
        featureName: Exclude<customerTierService.FeatureName, 'containerMaxInactivityTimeInMinutes' | 'supportAction'>,
        data?: {
            requiredAmount?: number;
            role?: string;
        }
    ): boolean;
    getSplitTestByEnvironmentName(environmentName: string): ISplitTest | undefined;
    listUsersByPermission(permission: Permission): Promise<IUserDoc[]>;
    addRequestedPublish(requester: IUserDoc, date: Date, text: string): Promise<void>;
    resolveRequestedPublishes(): Promise<IUserDoc[]>;
    hasPreviewBranch(): boolean;
    setCollaboratorNotificationSend(collaboratorId: string, notificationType: string): Promise<void>;
}

export type IProjectJSON = Writeable<Omit<IProject, 'collaborators' | 'collaborationInviteToken'>> &
    MongooseTimestamps &
    Pick<IProjectDoc, 'id' | 'availableFeatures' | 'tier' | 'eligibleForTrials' | 'classificationGroups'> & {
        collaborators?: ICollaboratorJSON[];
        permissions?: string[];
        roleSettings?: CollaboratorRoleSettings;
    };

export type IProjectSimpleJSON = Omit<IProjectJSON, 'ownerId' | 'organizationId' | 'projectGroupIds' | 'splitTests' | 'environments'> & {
    ownerId?: string;
    organizationId?: string;
    projectGroupIds?: string[];
    splitTests: ISplitTestSimpleJSON[];
    subscriptionEnded: boolean;
};

type ProjectPreviewFields = {
    id?: string;
    name?: string;
    siteUrl?: string;
    deploymentData: {
        container: {
            url?: string;
            status?: string;
            ssgState?: string;
        };
    };
};

type ProjectInsightQuery = {
    projectId: Types.ObjectId;
    date: Date;
    dailyVisits: number;
    monthlyVisits: number;
};

type BuildStatusParams = {
    message?: string | null;
    countDeploySuccess?: boolean;
    countDeploy?: boolean;
    buildStartTime?: Date;
    project?: IProjectDoc;
};

type SubscriptionUpdate = {
    endOfBillingCycle?: Date;
    scheduledForCancellation?: boolean;
    subscriptionId?: string;
    tierId?: string;
};

export interface IProjectModel extends Model<IProjectDoc>, SoftDeleteModel<IProjectDoc> {
    // statics
    getPreviewFields(project: IProjectDoc, environmentName?: string): ProjectPreviewFields;
    getContainerType(project: IProjectDoc): string | undefined;
    latestContentVersion(project: IProjectDoc, environmentName: string): string;
    latestContentUpdatedDate(project: IProjectDoc, environmentName: string): Date | undefined;
    createProject(project: Partial<IProject>, owner: IUserDoc, token?: string): Promise<IProjectDoc>;
    updateProject(id: Types.ObjectId, update: Partial<IProject>, userId: Types.ObjectId): Promise<IProjectDoc | null>;
    updateProjectAdmin(id: Types.ObjectId, key: string, value: any): Promise<IProjectDoc | null>;
    updateProjectInsights(queries: ProjectInsightQuery[]): Promise<void>;
    updateProjectRealScoreAutoScore(id: Types.ObjectId): Promise<IProject['metrics']['realScore'] | null>;
    incrementProjectStudioScore(id: Types.ObjectId, score: number): Promise<IProjectDoc | null>;
    bulkUpdateProjectsRealScores(): Promise<number[]>;
    duplicateProject(id: Types.ObjectId, userId: Types.ObjectId): Promise<IProjectDoc | null>;
    deleteProject(projectId: Types.ObjectId, userId: Types.ObjectId): Promise<void>;
    deleteProjectsByOwner(ownerId: Types.ObjectId): Promise<{ n: number }>;
    deleteProjectsByOwnerIds(userIds: Types.ObjectId[]): Promise<{ n: number }>;
    findProjectById(projectId: Types.ObjectId): Promise<IProjectDoc | null>;
    findNonDraftProjects(): Query<IProjectDoc[], IProjectDoc>;
    findNonDraftProjectIds(): Promise<Types.ObjectId[]>;
    findProjectByIdAndUser(projectId: Types.ObjectId | string, user: IUserDoc, permission: Permission): Promise<IProjectDoc | null>;
    findProjectByIdAndUserRoles(projectId: Types.ObjectId | string, user: IUserDoc, roles: CollaboratorRole[]): Promise<IProjectDoc | null>;
    findProjectByAllowedHostAndOwnerId(siteUrl: string, ownerId: Types.ObjectId): Promise<IProjectDoc | null>;
    findProjectByAllowedHostAndOwnerOrCollaboratorId(siteUrl: string, userId: Types.ObjectId): Promise<IProjectDoc | null>;
    findProjectByContainerName(containerName: string): Promise<IProjectDoc | null>;
    findProjectByContainerNameAndApiKey(containerName: string, key: string): Promise<IProjectDoc | null>;
    findProjectByNetlifySiteIdAndOwnerId(siteId: string, ownerId: Types.ObjectId): Promise<IProjectDoc | null>;
    findProjectByIdAndApiKey(id: Types.ObjectId, key: string, keyName?: string): Promise<IProjectDoc | null>;
    findAnonClaimableProjects(ownerId: Types.ObjectId): Promise<IProjectDoc[]>;
    findProjectByIdAndCollaboratorToken(id: Types.ObjectId | string, token: string): Promise<IProjectDoc | null>;
    findProjectByIdAndPreviewToken(id: Types.ObjectId, previewToken: string): Promise<IProjectDoc | null>;
    findUpgradeableContainerProjects(latestVersion: string): Promise<IProjectDoc[]>;
    updateClaimableProjects(ownerId: Types.ObjectId): Promise<void>;
    findOwnProjectsForUser(ownerId: Types.ObjectId): Promise<IProjectDoc[] | null>;
    findProjectsForUser(ownerId: Types.ObjectId, filter?: any): Query<IProjectDoc[], IProjectDoc>;
    findProjectsForOrganization(
        organizationId: Types.ObjectId,
        filterParams: ProjectListFilterParams,
        sortedPagesParams: SortedPagesParams
    ): Query<IProjectDoc[], IProjectDoc>;
    findProjectsWithDeletedForUser(ownerId: Types.ObjectId, filter: any): Promise<IProjectDoc[]>;
    findProjectsWithRunningLocalContainer(): Promise<IProjectDoc[]>;
    migrateProjectsToOwner(fromUserId: Types.ObjectId, toUserId: Types.ObjectId): Promise<void>;
    updateSiteUrl(projectId: Types.ObjectId, siteUrl: string): Promise<IProjectDoc | null>;
    addAllowedHost(projectId: Types.ObjectId, allowedHost: string): Promise<IProjectDoc | null>;
    updateDeploymentData(
        projectId: Types.ObjectId,
        deploymentId: string,
        update: any,
        environment?: string | null
    ): Promise<IProjectDoc | null>;
    updateSpaceById(projectId: Types.ObjectId, spaceId: string, environmentName: string, update: any): Promise<IProjectDoc | null>;
    updateMetrics(projectId: Types.ObjectId, update: any, inc: any): Promise<IProjectDoc | null>;
    updateDeveloperMetrics(projectId: Types.ObjectId, _commit: Record<string, any>): Promise<IProjectDoc | null>;
    forestryImported(projectId: Types.ObjectId, forestrySiteId: string): Promise<IProjectDoc | null>;
    setImportData(projectId: Types.ObjectId, data: IImportData): Promise<IProjectDoc | null>;
    setSplitTest(projectId: Types.ObjectId, data: ISplitTest): Promise<IProjectDoc | null>;
    createAPIKey(projectId: Types.ObjectId, name: string): Promise<IProjectDoc | null>;
    createAPIKeyWithKey(projectId: Types.ObjectId, name: string, key: string): Promise<IProjectDoc | null>;
    projectObjectForResponse(project: IProjectDoc, user: IUserDoc): Promise<IProjectJSON>;
    simpleProjectObjectForResponse(project: IProjectDoc, environmentName: string, user: IUserDoc): Promise<IProjectSimpleJSON>;
    generateProjectName(): string;
    updateBuildStatus(projectId: Types.ObjectId, status: string, params?: BuildStatusParams): Promise<IProjectDoc | null>;
    getProjectBySpaceId(query: { userId: Types.ObjectId; spaceId: string; CMS: 'contentful' }): Promise<IProjectDoc[]>;
    addInvitedCollaborator(
        project: IProjectDoc,
        user: IUserDoc,
        invite: Pick<ICollaborator, 'inviteToken' | 'inviteEmail' | 'role'>
    ): Promise<IProjectDoc | null>;
    updateCollaboratorByTokenAndUserId(
        project: IProjectDoc,
        inviteToken: string,
        userId: Types.ObjectId | string
    ): Promise<IProjectDoc | null>;
    removeCollaboratorById(project: IProjectDoc, collaboratorId: Types.ObjectId): Promise<IProjectDoc | null>;
    updateCollaboratorById(project: IProjectDoc, collaboratorId: Types.ObjectId | string, update: any): Promise<IProjectDoc | null>;
    getProjectIdsForSiteUrls(siteUrls: string[]): Promise<IProjectDoc[]>;
    updateUserEnvironment(projectId: Types.ObjectId, env: Record<string, string>): Promise<IProjectDoc | null>;
    cancelSubscription(projectId: Types.ObjectId, options?: { immediate?: boolean; skipEmail?: boolean }): Promise<IProjectDoc | null>;
    startSubscription(projectId: Types.ObjectId, subscription: { subscriptionId: string; tierId: string }): Promise<IProjectDoc | null>;
    updateSubscription(projectId: Types.ObjectId, update: SubscriptionUpdate): Promise<IProjectDoc | null>;
    projectTiersForUser(userId: Types.ObjectId): Promise<string[]>;
    setTierOverrides(project: IProjectDoc, overrides: customerTierService.CustomerTierFeatures): Promise<IProjectDoc | null>;
    addCurrentTierToPastTiers(project: IProjectDoc, overrideTier?: string): Promise<IProjectDoc | null>;
    disableCollaboratorsByTypes(project: IProjectDoc, collaboratorTypes: string[]): Promise<IProjectDoc>;
    limitNumberOfCollaboratorsEnabled(project: IProjectDoc, limit: number): Promise<IProjectDoc>;
    limitNumberOfViewersCollaboratorsEnabled(project: IProjectDoc, limit: number): Promise<IProjectDoc>;
    startTrial(project: IProjectDoc, tierId: string, setTrialStartedRecently?: boolean): Promise<IProjectDoc | null>;
    downgradePlanIfNeeded(project: IProjectDoc): Promise<IProjectDoc | null>;
    autoDowngradeExpiredProjects(): Promise<void>;
    detectOutOfSyncPaidProjects(): Promise<void>;
    unsetSubscriptionFlag(projectId: Types.ObjectId, flag: string): Promise<IProjectDoc | null>;
    findDeployedProjectsInLastPeriodWithViewers(period: Date): Promise<IProjectDoc[] | null>;
    findProjectsByWebhook(type: string, value: string): Promise<IProjectDoc[] | null>;
    setOrganizationIdForProject(projectId: Types.ObjectId, organizationId: Types.ObjectId): Promise<void>;
    addProjectToProjectGroup(projectId: Types.ObjectId, projectGroupId: Types.ObjectId): Promise<void>;
    removeProjectFromProjectGroup(projectId: Types.ObjectId, projectGroupId: Types.ObjectId): Promise<void>;
}

const ProjectSchema = makeTypeSafeSchema(
    new Schema<IProjectDoc, IProjectModel>(
        {
            name: String,
            ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
            organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
            projectGroupIds: { type: [Schema.Types.ObjectId] },
            thumbUrl: String,
            largeThumbUrl: String,
            wizard: {
                settings: {
                    type: Schema.Types.Mixed,
                    default: {}
                },
                theme: LayerSchema,
                ssg: LayerSchema,
                cms: LayerSchema,
                repository: LayerSchema,
                deployment: LayerSchema,
                container: LayerSchema
            },
            siteUrl: String, // link to deployed site
            allowedHosts: [String],
            deploymentData: {
                type: Schema.Types.Mixed,
                default: {}
            },
            environments: {
                type: Schema.Types.Mixed,
                default: {}
            },
            splitTests: [SplitTestSchema],
            settings: SettingsSchema,
            buildStatus: {
                type: String,
                enum: ['draft', 'building', 'build-failed', 'deploying', 'failing', 'live'],
                default: 'draft'
            },
            buildMessage: String,
            deployedAt: { type: Date },
            APIKeys: [
                {
                    name: String,
                    key: String
                }
            ],
            importData: { type: ImportDataSchema },
            widget: WidgetSchema,
            metrics: {
                deployCount: { type: Number, default: 0 },
                deploySuccessCount: { type: Number, default: 0 },
                didChangeNetlifyName: { type: Boolean, default: false },
                didChangeGithubName: { type: Boolean, default: false },
                buildStartTime: { type: Number, default: 0 },
                buildDuration: { type: Number, default: 0 },
                dailyVisitsDate: { type: Date },
                dailyVisits: { type: Number, default: 0 },
                monthlyVisits: { type: Number, default: 0 },
                buildDurationToFirstLive: { type: Number, default: 0 },
                hasDeveloperCommits: { type: Boolean, default: false },
                developerCommitCount: { type: Number, default: 0 },
                lastDeveloperCommitAt: { type: Date },
                realScore: {
                    manualScore: { type: Number, default: null },
                    autoScore: { type: Number, default: null }
                },
                studioScore: { type: Number, default: 0 }
            },
            alerts: [
                {
                    alertId: String,
                    alertType: { type: String, enum: [] },
                    message: { body: String, title: String },
                    action: { title: String, url: String },
                    alertClassName: String,
                    dismissable: Boolean
                }
            ],
            collaborationInviteToken: String,
            collaborators: [CollaboratorSchema],
            subscription: {
                // If the project recently had its trial expire, this value will be
                // set to the tier ID until the message is dismissed.
                trialExpiredRecently: String,

                // If the project recently had its paid plan expire, this value will be
                // set to the tier ID until the message is dismissed.
                paidPlanExpiredRecently: String,

                // If the project recently had a new trial start, this value will be
                // set to the tier ID until the message is dismissed.
                trialStartedRecently: String,

                // The date at which the current billing cycle ends. This value is
                // meant to be updated every time the subscription is renewed. If
                // this date is in the past, the subscription is inactive.
                endOfBillingCycle: Date,

                // ID of subscription in payment provider (e.g. Stripe).
                id: String,

                // If this field is set, any new subscription for this project will
                // benefit from a trial period, which means that the customer will
                // only be charged after this number of days.
                newSubscriptionTrialDays: Number,

                // It's possible for a non-authenticated user to start a subscription
                // for a project, as long as the request URL includes this token.
                paymentLinkToken: String,

                // Determines whether the subscription will be cancelled at the end of
                // the current billing cycle, at which point it becomes inactive.
                scheduledForCancellation: Boolean,

                // The ID of the tier, matching one of the tiers defined in the API
                // config (e.g. pro).
                tierId: String,

                // A hash of feature overrides, taking precedence over the features
                // defined for the tier (e.g. {collaborators: 500}).
                tierOverrides: customerTierService.SCHEMA,

                pastTierIds: { type: [String], default: [] }
            } as Record<keyof IProject['subscription'], any>,
            classifications: Schema.Types.Mixed,
            requestedPublishes: [
                {
                    requester: { type: Schema.Types.ObjectId, ref: 'User' },
                    date: { type: Date },
                    text: { type: String }
                }
            ],
            previewToken: String,
            webhooks: WebhooksSchema
        } as Record<keyof IProject, any>,
        {
            timestamps: true
        }
    )
);

// These paths can be overriden by an environment
const environmentSpecificPaths = [
    'container.newTaskArn',
    'container.newTaskCreatedAt',
    'container.taskArn',
    'container.prevTaskArn',
    'container.buildProgress',
    'container.lastActivity',
    'container.healthy',
    'container.hibernating',
    'container.name',
    'container.lastPreviewId',
    'container.branchStatus',
    'container.url',
    'container.internalUrl',
    'container.publishingVersion',
    'container.publishedVersion',
    'container.previewBranch',
    'container.publishBranch',
    'container.status',
    'contentful.publishedAt',
    'contentful.contentVersion',
    'contentful.versionOverride',
    'contentful.environment',
    'sanity.publishedAt',
    'sanity.contentVersion',
    'sanity.dataset',
    'git.branch',
    'forestry.branch',
    'netlifycms.branch',
    'netlify.connected',
    'netlify.deploy_id',
    'netlify.build_status',
    'netlify.buildProgress',
    'netlify.buildLog',
    'netlify.status_message',
    'netlify.screenshot_url',
    'netlify.summary',
    'netlify.buildHookUrl'
];

ProjectSchema.typeSafeVirtual('availableFeatures', function () {
    const tierId = this.subscription.tierId ?? customerTierService.DEFAULT_TIER_ID;
    const overrides = this.subscription.tierOverrides;
    const features = customerTierService.getTierFeatures(tierId, overrides);
    if (!features) {
        throw new Error(`invalid tier ID when accessing features: ${tierId}`);
    }
    return features;
});

ProjectSchema.typeSafeVirtual('tier', function () {
    const tierId = this.subscription.tierId ?? customerTierService.DEFAULT_TIER_ID;
    return {
        hooks: customerTierService.getTierHooks(tierId),
        isFree: customerTierService.isFreeTier(tierId)
    };
});

// Containers for a project must hibernate unless the tier includes
// the `hpPreviews` feature.
ProjectSchema.typeSafeVirtual('shouldHibernate', function () {
    return !this.checkTierAllowanceForFeature('hpPreviews');
});

ProjectSchema.typeSafeVirtual('containerMaxInactivityTimeInMinutes', function () {
    return this.availableFeatures.containerMaxInactivityTimeInMinutes;
});

ProjectSchema.typeSafeVirtual('previewContainerMode', function () {
    if (typeof this.settings.localContainerMode === 'boolean') {
        return this.settings.localContainerMode ? 'local' : 'shared';
    }
    return config.features.localContainerMode ? 'local' : 'shared';
});

ProjectSchema.index({ ownerId: 1 });
ProjectSchema.index({ organizationId: 1, createdAt: 1 });
ProjectSchema.index({ organizationId: 1, updatedAt: 1 });
ProjectSchema.index({ 'collaborators.userId': 1 });
ProjectSchema.index({ 'collaborators.userId': 1, 'collaborators.status': 1 });
ProjectSchema.index({ 'deploymentData.container.name': 1 }, { sparse: true });
ProjectSchema.index({ 'APIKeys.name': 1 }, { sparse: true });
ProjectSchema.index({ ownerId: 1, deleted: 1 });
ProjectSchema.index({ siteUrl: 1 });
ProjectSchema.index({ 'subscription.tierId': 1 });
ProjectSchema.index({ 'webhooks.github.repoName': 1 });
ProjectSchema.index({ createdAt: -1 });

ProjectSchema.plugin(mongoose_delete, {
    deletedAt: true,
    overrideMethods: ['count', 'find', 'findOne', 'findOneAndUpdate']
});

ProjectSchema.statics.getPreviewFields = function (project, environmentName?) {
    const response: ProjectPreviewFields = {
        ..._.pick(project, ['id', 'name', 'siteUrl']),
        deploymentData: {
            container: {
                url: project.deploymentData.container.url as string | undefined,
                status: project.deploymentData.container.status as string | undefined,
                ssgState: project.deploymentData.container.ssgState as string | undefined
            }
        }
    };

    if (environmentName) {
        environmentSpecificPaths.forEach((path) => {
            const keyExists = _.get(response.deploymentData, path) !== undefined;
            if (keyExists) {
                const component = path.split('.')[0]!;
                const val = _.get((project as IProjectJSON).environments[environmentName], path);
                // include null values only for existing components
                if (response.deploymentData[component as keyof typeof response.deploymentData] || !_.isEmpty(val)) {
                    _.set(response.deploymentData, path, val);
                }
            }
        });
    }

    return response;
};

ProjectSchema.typeSafeVirtual('subscription', 'safeTierId', function () {
    return this.subscription.tierId ?? customerTierService.DEFAULT_TIER_ID;
});

ProjectSchema.typeSafeVirtual('subscription', 'tierName', function () {
    return customerTierService.getTierName(this.subscription.safeTierId);
});

ProjectSchema.typeSafeVirtual('subscription', 'isFree', function () {
    return customerTierService.isFreeTier(this.subscription.safeTierId);
});

ProjectSchema.typeSafeVirtual('subscription', 'isTrial', function () {
    return customerTierService.getTierAttributes(this.subscription.safeTierId)?.isTrial ?? false;
});

ProjectSchema.typeSafeVirtual('subscription', 'paidTierId', function () {
    return customerTierService.getPaidTierIdOfTrial(this.subscription.safeTierId);
});

ProjectSchema.typeSafeVirtual('subscription', 'paidTierName', function () {
    return customerTierService.getPaidTierNameOfTrial(this.subscription.safeTierId);
});

ProjectSchema.typeSafeVirtual('classificationGroups', function () {
    return Object.fromEntries(
        Object.entries(this.classifications ?? {}).map(([rule, classification]) => [rule, (classification as any).group as string | null])
    );
});

ProjectSchema.typeSafeVirtual('eligibleForTrials', function () {
    return customerTierService.listTrialsWithEligibility(this);
});

ProjectSchema.statics.getContainerType = function (project) {
    const hasContainer = _.get(project, 'deploymentData.container');
    if (!hasContainer) {
        return;
    }
    const cmsId = _.get(project, 'wizard.cms.id');
    const importDataType = _.get(project, 'importData.dataType');
    return _.get(project, `deploymentData.container.${importDataType}`) ? importDataType : cmsId;
};

ProjectSchema.statics.latestContentVersion = function (project, environmentName?) {
    const allVersions: string[] = [];
    const cmsId = _.get(project, 'wizard.cms.id');
    const cmsVersion = project.getDeploymentData<string>(`${cmsId}.contentVersion`, environmentName);
    if (cmsVersion) {
        allVersions.push(cmsVersion);
    }
    const googleDocsVersion = project.getDeploymentData<string>('container.googledocs.contentVersion', environmentName);
    if (googleDocsVersion) {
        allVersions.push(googleDocsVersion);
    }
    return crypto.createHash('md5').update(allVersions.join('')).digest('hex');
};

ProjectSchema.statics.latestContentUpdatedDate = function (project, environmentName) {
    const cmsId = project.wizard?.cms?.id;
    const cmsPublishedAt = project.getDeploymentData<Date>(`${cmsId}.publishedAt`, environmentName);
    const googleDocsPublishedAt = project.getDeploymentData<Date>('container.googledocs.publishedAt', environmentName);
    return [cmsPublishedAt, googleDocsPublishedAt].reduce((res, cur) => {
        if (!res) {
            return cur;
        }
        return cur && cur > res ? cur : res;
    }, project.deployedAt);
};

ProjectSchema.statics.createProject = async function (project, owner, token) {
    let id;
    if (!token) {
        id = mongoose.Types.ObjectId();
    }
    if (token) {
        try {
            const projectId = await projectUtils.readProjectIdToken(token);
            id = mongoose.Types.ObjectId(projectId);
        } catch (err) {
            throw new ResponseError('InvalidProjectToken');
        }
    }
    (project as unknown as IProjectDoc)._id = id;
    project.ownerId = owner._id;
    project.name ??= this.generateProjectName();
    project.collaborationInviteToken = crypto.randomBytes(16).toString('hex');
    project.previewToken = uuid();
    (project as any).subscription ??= {};
    project.subscription!.tierId ??= owner.features.defaultCustomerTier;
    return new Project(project).save();
};

ProjectSchema.statics.updateProject = async function (id, update, userId) {
    const updateSet = _.pickBy(update, (_val, key: string) => {
        const pickArr = [
            'name',
            'thumbUrl',
            'largeThumbUrl',
            'siteUrl',
            'deploymentData',
            'deployedAt',
            'metrics',
            'wizard',
            'importData',
            'allowedHosts',
            'widget',
            'settings',
            'environments',
            'splitTests',
            'webhooks'
        ];
        if (pickArr.includes(key) && typeof (update as Record<string, any>)[key] !== 'undefined') {
            return true;
        }

        return _.some(pickArr, function (start) {
            return _.startsWith(key, start + '.');
        });
    });

    return Project.findOneAndUpdate(
        { _id: id, ownerId: userId },
        {
            ...updateSet,
            updatedAt: new Date()
        },
        { new: true }
    );
};

ProjectSchema.statics.updateProjectAdmin = async function (id, key, value) {
    return Project.findOneAndUpdate(
        { _id: id },
        {
            [key]: value,
            updatedAt: new Date()
        },
        { new: true }
    );
};

ProjectSchema.statics.updateProjectInsights = async function (queries) {
    if (queries.length === 0) {
        return;
    }
    await Project.updateMany(
        {},
        {
            // delete all previous daily/monthly data.
            $set: {
                'metrics.dailyVisitsDate': queries[0]!.date,
                'metrics.dailyVisits': 0,
                'metrics.monthlyVisits': 0
            }
        }
    );
    await Project.bulkWrite(
        queries.map((query) => ({
            updateOne: {
                filter: { _id: query.projectId },
                update: {
                    $set: {
                        'metrics.dailyVisitsDate': query.date,
                        'metrics.dailyVisits': query.dailyVisits,
                        'metrics.monthlyVisits': query.monthlyVisits
                    }
                }
            }
        }))
    );
};

ProjectSchema.statics.updateProjectRealScoreAutoScore = async function (id) {
    let project = await Project.findOne({ _id: id });
    if (!project) {
        return null;
    }

    const score = calculateProjectScore(project);

    project = await Project.findOneAndUpdate(
        { _id: id },
        {
            'metrics.realScore.autoScore': score,
            updatedAt: new Date()
        },
        { new: true }
    );
    return project?.metrics.realScore;
};

ProjectSchema.statics.incrementProjectStudioScore = async function (id, score) {
    return Project.findOneAndUpdate(
        { _id: id },
        {
            $inc: {
                'metrics.studioScore': score
            }
        },
        { new: true }
    );
};

ProjectSchema.statics.bulkUpdateProjectsRealScores = async function () {
    const filter = {
        buildStatus: { $ne: 'draft' },
        'metrics.deploySuccessCount': { $gte: 1 },
        'wizard.deployment.id': { $ne: 'container' }
    };

    const projects = await Project.find(filter);
    logger.debug(`updating ${projects.length} project scores`);
    const scores = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    projects.forEach((project) => {
        const newScore = calculateProjectScore(project);
        const oldScore = project.metrics.realScore?.autoScore;
        scores[newScore] += 1;
        if (newScore !== oldScore) {
            project.metrics.realScore = {
                manualScore: null,
                ...project.metrics.realScore,
                autoScore: newScore
            };
            project.save();
        }
    });
    logger.debug(`project scores updated - ${scores}`);
    return scores;
};

ProjectSchema.statics.duplicateProject = async function (id, userId) {
    const project = await Project.findOne({ _id: id, ownerId: userId });
    if (!project || !project.name) {
        return null;
    }

    const newProject = {
        name: projectUtils.duplicateProjectName(project.name),
        ownerId: userId,
        thumbUrl: project.thumbUrl,
        wizard: project.wizard,
        previewToken: uuid()
    };
    return new Project(newProject).save();
};

ProjectSchema.statics.deleteProject = async function (projectId, userId) {
    await Project.delete({ _id: projectId, ownerId: userId });
};

ProjectSchema.statics.deleteProjectsByOwner = async function (ownerId): Promise<{ n: number }> {
    return Project.delete({ ownerId });
};

ProjectSchema.statics.deleteProjectsByOwnerIds = async function (userIds): Promise<{ n: number }> {
    return Project.delete({ ownerId: { $in: userIds } });
};

ProjectSchema.statics.findProjectById = async function (projectId) {
    return Project.findOne({ _id: projectId });
};

ProjectSchema.statics.findNonDraftProjects = function () {
    return Project.find({ buildStatus: { $ne: 'draft' } });
};

ProjectSchema.statics.findNonDraftProjectIds = async function () {
    return (
        await Project.find({ buildStatus: { $ne: 'draft' } })
            .select({ _id: 1 })
            .lean()
    ).map((p) => p._id!);
};

ProjectSchema.statics.findProjectByIdAndUser = function (projectId, user, permission) {
    const roles = CollaboratorRole.listByPermission(permission);
    return this.findProjectByIdAndUserRoles(projectId, user, roles);
};

ProjectSchema.statics.findProjectByIdAndUserRoles = async function (projectId, user, roles) {
    if (!mongoose.isValidObjectId(projectId)) {
        return null;
    }

    if (roles.includes(CollaboratorRole.STACKBIT_ADMIN)) {
        const userRoles = await user.getRoles();
        const isAdmin = userRoles.includes('admin');
        // if user is Stackbit admin, any project can be returned
        if (isAdmin) {
            return Project.findOne({ _id: projectId });
        }
    }

    if (roles.includes(CollaboratorRole.STACKBIT_SUPPORT_ADMIN)) {
        const userRoles = await user.getRoles();
        const isSupportAdmin = userRoles.includes('support_admin');
        // if user is Stackbit admin, any project can be returned
        if (isSupportAdmin) {
            return Project.findOne({ _id: projectId });
        }
    }

    // query logic according to roles
    const userId = user.id;
    const roleQueries = _.reduce(
        roles,
        (accum: any[], role) => {
            if (role === CollaboratorRole.OWNER) {
                accum.push({ _id: projectId, ownerId: userId });
            } else {
                if (role.isDefaultCollaboratorRole()) {
                    accum.push({
                        _id: projectId,
                        collaborators: {
                            $elemMatch: {
                                userId,
                                role: { $exists: false }
                            }
                        }
                    });
                }
                accum.push({
                    _id: projectId,
                    collaborators: {
                        $elemMatch: {
                            userId,
                            role: role.name
                        }
                    }
                });
            }
            return accum;
        },
        []
    );

    if (roleQueries.length) {
        return Project.findOne({ $or: roleQueries });
    }

    return null;
};

ProjectSchema.statics.findProjectByAllowedHostAndOwnerId = async function (siteUrl, ownerId) {
    const host = new URL(siteUrl).origin;
    return Project.findOne({ allowedHosts: host, ownerId });
};

ProjectSchema.statics.findProjectByAllowedHostAndOwnerOrCollaboratorId = async function (siteUrl, userId) {
    const host = new URL(siteUrl).origin;
    return Project.findOne({
        $or: [
            { allowedHosts: host, ownerId: userId },
            { allowedHosts: host, 'collaborators.userId': userId }
        ]
    });
};

ProjectSchema.statics.findProjectByContainerName = async function (containerName) {
    return Project.findOne({ 'deploymentData.container.name': containerName });
};

ProjectSchema.statics.findProjectByContainerNameAndApiKey = async function (containerName, key) {
    return Project.findOne({ 'deploymentData.container.name': containerName, APIKeys: { $elemMatch: { key: key } } });
};

ProjectSchema.statics.findProjectByNetlifySiteIdAndOwnerId = async function (siteId, ownerId) {
    return Project.findOne({ 'deploymentData.netlify.id': siteId, ownerId: ownerId });
};

ProjectSchema.statics.findProjectByIdAndApiKey = async function (id, key, keyName) {
    if (!mongoose.isValidObjectId(id)) {
        return null;
    }
    const keyObj: { key: string; name?: string } = { key };
    if (keyName) {
        keyObj.name = keyName;
    }
    return Project.findOne({ _id: id, APIKeys: { $elemMatch: keyObj } });
};

ProjectSchema.statics.findAnonClaimableProjects = async function (ownerId) {
    return Project.find({
        ownerId: ownerId,
        'deploymentData.netlify.anonFlow': true,
        'deploymentData.netlify.claimToken': { $exists: true }
    });
};

ProjectSchema.statics.findProjectByIdAndCollaboratorToken = async function (id, token) {
    return Project.findOne({
        $or: [
            // backward compatibility query
            // collaborationInviteToken - deprecated
            { _id: id, collaborationInviteToken: token },
            {
                _id: id,
                collaborators: {
                    $elemMatch: { inviteToken: token }
                }
            }
        ]
    });
};

ProjectSchema.statics.findProjectByIdAndPreviewToken = async function (id, previewToken) {
    if (!previewToken || !mongoose.isValidObjectId(id)) {
        return null;
    }
    return Project.findOne({ _id: id, previewToken });
};

ProjectSchema.statics.findUpgradeableContainerProjects = async function (latestVersion) {
    const maxLastActivity = new Date(Date.now() - 3600000 * 6);
    return Project.find({
        'wizard.container.id': 'sharedContainer',
        'deploymentData.container.version': { $ne: latestVersion }, // not running latest version
        'deploymentData.container.taskArn': { $ne: null }, // has active task
        'deploymentData.container.newTaskArn': { $eq: null }, // no upgrade in progress
        'deploymentData.container.lastActivity': { $lt: maxLastActivity }, // inactive for over 6 hours
        createdAt: { $lt: maxLastActivity }, // ignore projects just created
        $or: [
            // don't attempt upgrade more frequently than every 1 hour
            { 'deploymentData.container.lastUpgradeAt': { $exists: false } },
            { 'deploymentData.container.lastUpgradeAt': { $lt: new Date(Date.now() - 3600000) } }
        ]
    }).sort({ 'deploymentData.container.lastUpgradeAt': 1 }); // return most recently upgraded last
};

ProjectSchema.statics.updateClaimableProjects = async function (ownerId) {
    await Project.updateMany(
        {
            ownerId: ownerId,
            'deploymentData.netlify.claimToken': { $exists: true }
        },
        {
            $set: { 'deploymentData.netlify.claimDate': new Date() },
            $unset: {
                'deploymentData.netlify.claimToken': '',
                'deploymentData.netlify.hasRestrictedWebhooks': ''
            }
        }
    );
};

ProjectSchema.statics.findOwnProjectsForUser = async function (ownerId) {
    return Project.find({ ownerId });
};

ProjectSchema.statics.findProjectsForUser = function (ownerId, filter?) {
    return Project.find(
        { $or: [{ ownerId }, { collaborators: { $elemMatch: { userId: ownerId, status: { $in: [null, 'collaborator'] } } } }], ...filter },
        null,
        { sort: { [DEFAULT_LIST_SORT_BY]: DEFAULT_LIST_SORT_DIRECTION } }
    );
};

ProjectSchema.statics.findProjectsForOrganization = function (organizationId, filterParams, sortedPagesParams) {
    const sotredPagesDef = createMongooseQuery(
        sortedPagesParams,
        DEFAULT_LIST_SORT_BY,
        DEFAULT_LIST_SORT_DIRECTION,
        DEFAULT_LIST_PAGE_SIZE
    );

    const filter: Record<string, any> = { organizationId, ...sotredPagesDef.filter };

    if (filterParams.themeId) {
        filter['wizard.theme.id'] = filterParams.themeId;
    }
    if (filterParams.namePart) {
        filter['name'] = { $regex: filterParams.namePart.toLowerCase() };
    }

    return Project.find(filter, null, sotredPagesDef.options);
};

ProjectSchema.statics.findProjectsWithDeletedForUser = async function (ownerId, filter?) {
    return Project.findWithDeleted(
        { $or: [{ ownerId }, { collaborators: { $elemMatch: { userId: ownerId, status: { $in: [null, 'collaborator'] } } } }], ...filter },
        null,
        { sort: { [DEFAULT_LIST_SORT_BY]: DEFAULT_LIST_SORT_DIRECTION } }
    );
};

// This function doesn't work with environments (what used to be Split Testing).
// Fix this function if environments are ever revived.
ProjectSchema.statics.findProjectsWithRunningLocalContainer = async function () {
    return Project.find({
        $or: [
            { 'deploymentData.container.localTask.pid': { $exists: true } },
            { 'deploymentData.container.newLocalTask.pid': { $exists: true } }
        ]
    });
};

ProjectSchema.statics.migrateProjectsToOwner = async function (fromUserId, toUserId) {
    logger.debug(`[migrateProjectsToOwner] migrating projects from userId ${fromUserId} => ${toUserId}`);
    await Project.updateMany({ ownerId: fromUserId }, { ownerId: toUserId }, { multi: true });
};

ProjectSchema.statics.updateSiteUrl = async function (projectId, siteUrl) {
    const project = await Project.findOne({ _id: projectId });
    if (!project) {
        return null;
    }
    const host = new URL(siteUrl).origin;
    project.allowedHosts = (project.allowedHosts || []).concat(host);
    project.siteUrl = siteUrl;
    return project.save();
};

ProjectSchema.statics.addAllowedHost = async function (projectId, allowedHost) {
    const project = await Project.findOne({ _id: projectId });
    if (!project) {
        return null;
    }
    project.allowedHosts = _.uniq((project.allowedHosts || []).concat(allowedHost));
    return project.save();
};

ProjectSchema.statics.updateDeploymentData = async function (projectId, deploymentId, update, environment) {
    const key = environment ? `environments.${environment}.${deploymentId}` : `deploymentData.${deploymentId}`;
    const updateObj = makeSetUnsetUpdateObj(key, update);
    return Project.findOneAndUpdateWithDeleted({ _id: projectId }, updateObj, { new: true });
};

ProjectSchema.methods.getDefaultBranch = function () {
    const repoId = this.wizard?.repository?.id;
    return this.getDeploymentData(`${repoId}.defaultBranch`, undefined, 'master');
};

ProjectSchema.methods.getContainerBranches = function (environment) {
    const publishBranch = this.getDeploymentData('container.publishBranch', environment, this.getDefaultBranch());
    const previewBranch = this.getDeploymentData('container.previewBranch', environment, publishBranch);
    return { previewBranch, publishBranch };
};

type GetDeploymentData = {
    <T>(this: IProjectDoc, path: string, environment?: string | null): T | undefined;
    <T>(this: IProjectDoc, path: string, environment: string | null | undefined, defaultVal: T): T;
};
ProjectSchema.methods.getDeploymentData = function <T>(
    this: IProjectDoc,
    path: string,
    environment?: string | null,
    defaultVal?: T
): T | undefined {
    const allowFallback = environment && !environmentSpecificPaths.includes(path);
    return (
        environment
            ? _.get(
                  this,
                  `environments.${environment}.${path}`,
                  allowFallback ? _.get(this, `deploymentData.${path}`, defaultVal) : defaultVal
              )
            : _.get(this, `deploymentData.${path}`, defaultVal)
    ) as T | undefined;
} as GetDeploymentData;

ProjectSchema.statics.updateSpaceById = async function (projectId, spaceId, environmentName, update) {
    return Project.findOne({ _id: projectId }).then((project) => {
        if (_.find(_.get(project, 'deploymentData.contentful.spaces', []), { spaceId: spaceId })) {
            const updateObj = makeSetUnsetUpdateObj('deploymentData.contentful.spaces.$', update);
            return Project.findOneAndUpdate({ _id: projectId, 'deploymentData.contentful.spaces.spaceId': spaceId }, updateObj, {
                new: true
            });
        } else if (_.get(project, 'deploymentData.contentful.spaceId') === spaceId) {
            return Project.updateDeploymentData(projectId, 'contentful', update, environmentName);
        } else {
            throw new ResponseError('ContentfulSpaceNotFound');
        }
    });
};

ProjectSchema.statics.updateMetrics = async function (projectId, update, inc) {
    const updateObj = makeSetUnsetUpdateObj('metrics', update, { inc });
    return Project.findOneAndUpdate({ _id: projectId }, updateObj, { new: true });
};

ProjectSchema.statics.updateDeveloperMetrics = async function (projectId) {
    const update = {
        'metrics.hasDeveloperCommits': true,
        'metrics.lastDeveloperCommitAt': new Date(),
        $inc: { 'metrics.developerCommitCount': 1 }
    };
    return Project.findOneAndUpdate({ _id: projectId }, update, { new: true, runValidators: true });
};

ProjectSchema.statics.forestryImported = async function (projectId, forestrySiteId) {
    if (!forestrySiteId) {
        throw 'Forestry site id missing';
    }
    const update = {
        'deploymentData.forestry.connected': true,
        'deploymentData.forestry.siteId': forestrySiteId,
        'deploymentData.forestry.url': `https://app.forestry.io/sites/${forestrySiteId}/`
    };
    return Project.findOneAndUpdate({ _id: projectId }, update, { new: true });
};

ProjectSchema.statics.setImportData = async function (projectId, data) {
    const update = {
        importData: data
    };
    return Project.findOneAndUpdate({ _id: projectId }, update, { new: true });
};

ProjectSchema.statics.setSplitTest = async function (projectId, data) {
    const update = {
        splitTests: [data]
    };
    return Project.findOneAndUpdate({ _id: projectId }, update, { new: true });
};

ProjectSchema.statics.createAPIKey = async function (projectId, name) {
    const token = { name: name, key: crypto.randomBytes(32).toString('hex') };
    const update = { $push: { APIKeys: token } };
    return Project.findOneAndUpdate({ _id: projectId }, update, { new: true });
};

ProjectSchema.statics.createAPIKeyWithKey = async function (projectId, name, key) {
    const token = { name, key };
    const update = { $push: { APIKeys: token } };
    return Project.findOneAndUpdate({ _id: projectId }, update, { new: true });
};

ProjectSchema.statics.projectObjectForResponse = async function (project, user) {
    return Object.assign({}, project.toJSON() as unknown as IProjectJSON, {
        permissions: (await project.getCollaboratorRole(user)).listPermissions(),
        APIKeys: (project.APIKeys ?? []).filter((apiKey) => apiKey.name !== 'container-key'),
        collaborationInviteToken: undefined
    });
};

ProjectSchema.statics.simpleProjectObjectForResponse = async function (project, environmentName, user) {
    let result = JSON.parse(JSON.stringify(project)) as IProjectSimpleJSON;

    result.ownerId = result.ownerId?.toString();
    result.organizationId = result.organizationId?.toString();
    result.projectGroupIds = (result.projectGroupIds ?? []).map((projectGroup) => projectGroup?.toString());

    // resolve environment-specific values
    if (environmentName) {
        result.deploymentData = _.merge(result.deploymentData, (result as unknown as IProjectJSON).environments[environmentName]);
        environmentSpecificPaths.forEach((path) => {
            const component = path.split('.')[0]!;
            const val = _.get((result as unknown as IProjectJSON).environments[environmentName], path);
            // include null values only for existing components
            if (result.deploymentData[component] || !_.isEmpty(val)) {
                _.set(result.deploymentData, path, val);
            }
        });
    }
    // include environment info in split-test
    result.splitTests[0]?.variants?.forEach((variant) => {
        variant.netlifyStatus = project.getDeploymentData('netlify.buildProgress', variant.environment);
        variant.containerStatus = project.getDeploymentData('container.buildProgress', variant.environment);
        variant.containerHealthy = project.getDeploymentData('container.healthy', variant.environment);
    });
    // remove sensitive values
    result.APIKeys = (result.APIKeys ?? []).filter((apiKey) => apiKey.name !== 'container-key');
    result.APIKeys.forEach((k) => delete (k as typeof k & { _id?: Types.ObjectId })._id);
    result = omitDeep(result, 'environments', 'collaborationInviteToken', 'subscription.paymentLinkToken') as IProjectSimpleJSON;

    result.deploymentData = omitDeep(
        result.deploymentData,
        'build.outputDir',
        'build.rmdir',
        'container.deployPrivateKey',
        'container.codeEditorKey',
        'container.deployPublicKey',
        'container.lastActivity'
    ) as IProjectSimpleJSON;

    // pass taskArn but hide the value
    if (project.getDeploymentData('container.taskArn')) {
        result.deploymentData.container.taskArn = true;
    }
    if (project.getDeploymentData('container.newTaskArn')) {
        result.deploymentData.container.newTaskArn = true;
    }
    if (project.getDeploymentData('container.codeEditorKey')) {
        result.deploymentData.container.codeEditorUrl = new URL(
            `/${project.getDeploymentData('container.codeEditorKey')}/_codeEditor/`,
            project.getDeploymentData('container.url', environmentName)
        );

        result = omitDeep(result, 'deploymentData.container.codeEditorKey') as IProjectSimpleJSON;
    }

    result.availableFeatures.environments = project.availableFeatures.environments;

    const role = await project.getCollaboratorRole(user);
    result.roleSettings = role.getSettings();
    result.permissions = role.listPermissions();
    result.subscriptionEnded = await project.isSubscriptionEnded();
    result.widget.codeEditorEnabled =
        result.widget.codeEditorEnabled && project.hasPreviewBranch() && !project.wizard?.theme?.settings?.multiSite;
    result.widget.schemaEditorEnabled = result.widget.schemaEditorEnabled && !project.wizard?.theme?.settings?.multiSite;

    return result;
};

ProjectSchema.methods.getCollaboratorRole = async function (user) {
    if (user.id === this.ownerId?.toString()) {
        return CollaboratorRole.OWNER;
    }
    const collaborator = this.collaborators?.find((c) => c.userId && c.userId.toString() === user.id);
    if (collaborator) {
        return collaborator.roleOrDefault;
    }
    const userRoles = await user.getRoles();
    if (userRoles.includes('admin') && userRoles.includes('support_admin')) {
        return CollaboratorRole.STACKBIT_SUPPORT_ADMIN;
    }
    if (userRoles.includes('admin')) {
        return CollaboratorRole.STACKBIT_ADMIN;
    }
    return CollaboratorRole.NONE;
};

ProjectSchema.methods.isSubscriptionEnded = async function () {
    const tierId = this.subscription.tierId ?? customerTierService.DEFAULT_TIER_ID;
    if (customerTierService.isFreeTier(tierId)) {
        return false;
    }

    // Paid plans that are not scheduled for cancellation and might just be out-of-sync with Stripe.
    // We don't regard them as expired, instead we have a daily task to alert that they are out-of-sync.
    if (!customerTierService.isTrialTier(tierId) && !this.subscription.scheduledForCancellation) {
        return false;
    }

    const tierEndDate = this.subscription.endOfBillingCycle;

    return !tierEndDate || Date.now() >= tierEndDate.getTime();
};

ProjectSchema.statics.generateProjectName = function () {
    return nameGenerator.generate();
};

ProjectSchema.statics.updateBuildStatus = async function (
    projectId,
    status,
    { message = null, countDeploySuccess = false, countDeploy = false, buildStartTime, project } = {}
) {
    const update: any = {
        $set: {
            buildStatus: status,
            buildMessage: message
        }
    };

    if (countDeploy) {
        update.$inc = { 'metrics.deployCount': 1 };
    }

    if (countDeploySuccess) {
        if (_.get(project, 'metrics.deploySuccessCount') === 0 && _.get(project, 'metrics.buildStartTime')) {
            const buildTimeStart = _.get(project, 'metrics.buildStartTime');
            update.$set['metrics.buildDurationToFirstLive'] = (new Date().getTime() - buildTimeStart) / 1000;
        }

        update.$inc = { 'metrics.deploySuccessCount': 1 };
        update.$set['deployedAt'] = new Date();
    }

    if (buildStartTime) {
        update.$set['metrics.buildStartTime'] = buildStartTime;
    }

    return Project.findOneAndUpdate({ _id: projectId }, update, { new: true, runValidators: true });
    // Todo: save build data as well
};

ProjectSchema.statics.getProjectBySpaceId = async function ({ userId, spaceId, CMS }) {
    return Project.findProjectsForUser(userId)
        .find({
            $and: [{ deploymentData: { $exists: true } }, { [`deploymentData.${CMS}.spaceId`]: spaceId }]
        })
        .limit(1);
};

ProjectSchema.methods.dismissAlert = function (alertId) {
    const alertIndex = _.findIndex(this.alerts, { alertId });
    if (alertIndex > -1) {
        this.alerts.splice(alertIndex, 1);
    }

    return this.save();
};

ProjectSchema.statics.addInvitedCollaborator = async function (
    project,
    user,
    { inviteToken, inviteEmail, role }
): Promise<IProjectDoc | null> {
    if (!inviteToken || !inviteEmail) {
        throw new Error('No data to create collaborator');
    }

    const userId = mongoose.Types.ObjectId(user.id);
    const isCollaborator = _.find(project.collaborators, { userId });
    const isOwner = userId.toString() === project.ownerId?.toString();
    if (!isOwner && !isCollaborator) {
        throw new ResponseError('UserDoesNotOwnProject');
    }

    return Project.findOneAndUpdate(
        { _id: project._id },
        {
            $addToSet: { collaborators: { inviteToken, inviteEmail, role } as any }
        },
        { new: true }
    );
};

ProjectSchema.statics.updateCollaboratorByTokenAndUserId = async function (project, inviteToken, userId) {
    if (!inviteToken || !userId) {
        throw new Error('Pass data to update collaborator');
    }

    const collaborators = project.collaborators;
    const collaboratorByToken = _.find(collaborators, { inviteToken });

    if (!collaboratorByToken) {
        throw new ResponseError('CollaboratorTokenInvalid');
    }

    const collaboratorById = _.find(collaborators, { userId: userId });
    if (collaboratorById) {
        throw new ResponseError('AlreadyCollaborator');
    }

    const query = {
        _id: project._id,
        collaborators: {
            $elemMatch: { inviteToken }
        }
    };

    return Project.findOneAndUpdate(
        query,
        {
            $set: {
                'collaborators.$.userId': userId,
                'collaborators.$.inviteEmail': null,
                'collaborators.$.inviteToken': null
            }
        },
        { new: true }
    );
};

ProjectSchema.statics.removeCollaboratorById = async function (project, collaboratorId) {
    const collaborator = _.find(project.collaborators, { id: collaboratorId });

    if (!collaborator) {
        throw new ResponseError('CollaboratorDoesNotExist');
    }

    return Project.findOneAndUpdate(
        { _id: project.id },
        {
            $pull: { collaborators: { _id: collaboratorId } }
        },
        { new: true }
    );
};

ProjectSchema.statics.updateCollaboratorById = async function (project, collaboratorId, update) {
    const collaborator = _.find(project.collaborators, { id: collaboratorId });

    if (!collaborator) {
        throw new ResponseError('CollaboratorDoesNotExist');
    }

    const query = {
        _id: project._id,
        collaborators: {
            $elemMatch: { _id: collaboratorId }
        }
    };

    const updateOperation = Object.fromEntries(Object.entries(update).map(([key, value]) => [`collaborators.$.${key}`, value]));

    return Project.findOneAndUpdate(query, { $set: updateOperation }, { new: true });
};

ProjectSchema.statics.getProjectIdsForSiteUrls = async function (siteUrls) {
    return Project.find({ siteUrl: { $in: siteUrls } }, ['projectId', 'siteUrl']);
};

ProjectSchema.statics.updateUserEnvironment = async function (projectId, env) {
    return Project.findOneAndUpdate(
        { _id: projectId },
        {
            'deploymentData.container.env': env
        },
        { new: true }
    );
};

function reportTierCancelationToAnalytics(project: IProjectDoc, tierId: string, owner: IUserDoc | null) {
    const props = {
        projectId: project.id,
        projectUrl: project.siteUrl,
        userId: owner?.id,
        userEmail: owner?.email,
        tierId
    };
    if (customerTierService.isTrialTier(tierId)) {
        analytics.track('Trial Expired', props, owner);
    } else {
        analytics.track('Subscription Canceled', props, owner);
    }
}

ProjectSchema.statics.cancelSubscription = async function (projectId, { immediate, skipEmail } = {}) {
    const User = mongoose.models.User as IUserModel; // prevent dependency loop
    if (immediate) {
        let project = await Project.findById(projectId);
        if (!project) {
            return null;
        }
        const previousTierId = project.subscription.safeTierId;
        const { isFree, isTrial, downgradesTo } = customerTierService.getTierAttributes(previousTierId) ?? {};
        const owner = await User.findById(project.ownerId);
        const tierId = downgradesTo ?? (owner && customerTierService.getDefaultTierIdForUser(owner));
        if (!tierId) {
            return project;
        }
        project = await Project.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    'subscription.tierId': tierId,
                    'subscription.trialExpiredRecently': isTrial ? previousTierId : undefined,
                    'subscription.paidPlanExpiredRecently': !isFree && !isTrial ? previousTierId : undefined
                },
                $unset: {
                    'subscription.id': '',
                    'subscription.trialStartedRecently': '',
                    'subscription.scheduledForCancellation': ''
                }
            },
            { new: true }
        );
        if (!project) {
            return null;
        }
        reportTierCancelationToAnalytics(project, previousTierId, owner);
        project = await customerTierService.updateProjectAfterTierChange(project, previousTierId);
        return project;
    } else {
        const project = await Project.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    'subscription.scheduledForCancellation': true
                }
            },
            { new: true }
        );
        if (!project) {
            return null;
        }
        const owner = await User.findById(project.ownerId);
        reportTierCancelationToAnalytics(project, project.subscription.safeTierId, owner);
        if (!skipEmail) {
            await sendPlansEmail(project, project.subscription.safeTierId, PLANS_EMAIL_EVENT.CANCELLED);
        }
        return project;
    }
};

ProjectSchema.statics.startSubscription = async function (projectId, { subscriptionId, tierId }) {
    let project = await Project.findById(projectId);
    if (!project) {
        return null;
    }
    const previousTierId = project.subscription.safeTierId;
    const subscription = {
        'subscription.trialEligibility': false,
        'subscription.scheduledForCancellation': false,
        'subscription.id': subscriptionId,
        'subscription.tierId': tierId
    };
    project = await Project.findOneAndUpdate({ _id: projectId }, { $set: subscription }, { new: true });
    if (!project) {
        return null;
    }
    project = await customerTierService.updateProjectAfterTierChange(project, previousTierId);
    return project;
};

ProjectSchema.statics.updateSubscription = async function (
    projectId,
    { endOfBillingCycle, scheduledForCancellation, subscriptionId, tierId }
) {
    let project = await Project.findById(projectId);
    if (!project) {
        return null;
    }
    const previousTierId = project.subscription.safeTierId;
    const updateObj: any = {};
    if (endOfBillingCycle) {
        updateObj['subscription.endOfBillingCycle'] = endOfBillingCycle;
    }
    if (typeof scheduledForCancellation === 'boolean') {
        updateObj['subscription.scheduledForCancellation'] = scheduledForCancellation;
    }
    if (subscriptionId) {
        updateObj['subscription.id'] = subscriptionId;
    }
    if (tierId) {
        updateObj['subscription.tierId'] = tierId;
    }
    project = await Project.findOneAndUpdate({ _id: projectId }, { $set: updateObj }, { new: true });
    if (project && previousTierId !== project.subscription.tierId) {
        project = await customerTierService.updateProjectAfterTierChange(project, previousTierId);
    }
    return project;
};

ProjectSchema.methods.hasSubscription = function () {
    return !!this.subscription.id;
};

ProjectSchema.statics.projectTiersForUser = async function (userId) {
    return Project.distinct('subscription.tierId', {
        $or: [{ ownerId: userId }, { collaborators: { $elemMatch: { userId: userId, status: { $in: [null, 'collaborator'] } } } }]
    });
};

ProjectSchema.methods.getUserEnvironment = function () {
    return this.getDeploymentData('container.env');
};

ProjectSchema.methods.getCustomerTier = function () {
    const tierId = this.subscription.safeTierId;
    const overrides = this.subscription.tierOverrides;
    const tierName = customerTierService.getTierName(tierId);
    const features = customerTierService.getTierFeatures(tierId, overrides);

    return {
        name: tierName,
        features
    };
};

ProjectSchema.methods.getPaymentLinkTokenOrGenerateNew = async function () {
    const existingToken = this.subscription.paymentLinkToken;
    if (existingToken) {
        return existingToken;
    }
    const newToken = uuid();
    this.subscription.paymentLinkToken = newToken;
    await this.save();
    return newToken;
};

ProjectSchema.methods.checkTierAllowanceForFeature = function (featureName, { requiredAmount = 1, role = '' } = {}) {
    const tierId = this.subscription.tierId ?? customerTierService.DEFAULT_TIER_ID;
    const overrides = this.subscription.tierOverrides;
    const features = customerTierService.getTierFeatures(tierId, overrides);

    if (!features) {
        return false;
    }

    switch (featureName as any) {
        case 'collaborators': {
            // The required value for the feature is typically a `true` Boolean, except
            // for some specific features. We handle them here.

            const existingCollaborators = this.collaborators?.filter(({ role }) => role !== CollaboratorRole.UNLICENSED.name);
            const availableCollaborators = Number(features[featureName]) ?? 0;
            const viewersCount =
                existingCollaborators?.filter(({ role }) => role === CollaboratorRole.VIEWER.name).length ?? 0 + requiredAmount;
            const editorsAndPublishersCount =
                existingCollaborators?.filter(({ role = '' }) =>
                    [CollaboratorRole.EDITOR.name, CollaboratorRole.DEVELOPER.name, CollaboratorRole.ADMIN.name].includes(role)
                ).length ?? 0 + requiredAmount;

            switch (role) {
                case CollaboratorRole.VIEWER.name:
                    return viewersCount <= (features?.viewersCollaborators ?? 0);
                case CollaboratorRole.EDITOR.name:
                case CollaboratorRole.DEVELOPER.name:
                    if (!features.collaboratorRoles) {
                        return false;
                    }
                    return editorsAndPublishersCount <= availableCollaborators;
                case CollaboratorRole.ADMIN.name:
                    return editorsAndPublishersCount <= availableCollaborators;
                default:
                    // unsupported type of collaborator
                    return false;
            }
        }

        case 'environments': {
            // user get 1 env by default, other environments add to environments record
            // sum of user environments will be Object.values(this.environments).length + 1 (default env)
            // if users tier has e.g. 2 environments - user can have only one additional environment record in "environments" property
            const required = Object.values(this.environments).length ?? 0 + requiredAmount;
            return required < (features[featureName] ?? 0);
        }

        default: {
            return Boolean(features[featureName]);
        }
    }
};

ProjectSchema.methods.getSplitTestByEnvironmentName = function (environmentName) {
    return _.find(this.splitTests, { variants: [{ environment: environmentName }] });
};

ProjectSchema.methods.listUsersByPermission = async function (permission) {
    const User = mongoose.models.User as IUserModel;
    const roleNames = CollaboratorRole.listByPermission(permission).map((role) => role.name);
    const userIds = (this.collaborators?.filter((collaborator) => roleNames.includes(collaborator.role!)) ?? []).map(
        (collaborator) => collaborator.userId!
    );
    if (roleNames.includes(CollaboratorRole.OWNER.name) && this.ownerId) {
        userIds.push(this.ownerId);
    }
    return User.findUsersById(userIds);
};

/* Product note: Since we currently treat all requested publishes the same, that is
   we don't know if a specific publish answered all requests or only some, we don't
   allow for a single user to have multiple pending requests at the time same.

   If we change this in the future, we might want to keep track of all requests, not
   just the latest one, and notify on each one when it has been approved. */
ProjectSchema.methods.addRequestedPublish = async function (requester, date, text) {
    this.requestedPublishes = this.requestedPublishes.filter((req) => req.requester !== requester._id);
    this.requestedPublishes.push({
        requester: requester._id,
        date,
        text
    });
    await this.save();
};

ProjectSchema.methods.resolveRequestedPublishes = async function () {
    const User = mongoose.models.User as IUserModel;
    const requestedPublishes = this.requestedPublishes.map((r) => (r as typeof r & Types.Subdocument).toObject());
    this.requestedPublishes = [];
    await this.save();
    return User.findUsersById(requestedPublishes.map((request) => request.requester!));
};

ProjectSchema.methods.hasPreviewBranch = function () {
    const previewBranch = _.get(this, 'deploymentData.container.previewBranch');
    return previewBranch && previewBranch !== _.get(this, 'deploymentData.container.publishBranch');
};

ProjectSchema.methods.setCollaboratorNotificationSend = async function (collaboratorId, notificationType) {
    const collaborator = this.collaborators?.find(({ userId = '' }) => userId === collaboratorId);

    if (!collaborator) {
        throw new Error('No collaborator found');
    }

    collaborator.notifications = collaborator.notifications || [];
    const notification = projectUtils.findCollaboratorNotificationByType(collaborator.notifications, { notificationType });

    if (notification) {
        notification.lastSentAt = new Date();
    } else {
        collaborator.notifications.push({
            lastSentAt: new Date(),
            type: notificationType
        });
    }

    await this.save();
};

ProjectSchema.statics.setTierOverrides = async function (project, overrides) {
    const overrideSets = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [`subscription.tierOverrides.${k}`, v]));
    return Project.findOneAndUpdate(
        { _id: project._id },
        {
            $set: overrideSets
        },
        { new: true }
    );
};

ProjectSchema.statics.addCurrentTierToPastTiers = async function (project, overrideTier?) {
    return Project.findOneAndUpdate(
        { _id: project._id },
        {
            $addToSet: { 'subscription.pastTierIds': overrideTier ?? project.subscription.tierId }
        },
        { new: true }
    );
};

async function unlicenseCollaborators(project: IProjectDoc, collaboratorsQuery: any): Promise<IProjectDoc> {
    const updatedProject = await Project.findOneAndUpdate(
        {
            _id: project._id
        },
        {
            $set: {
                'collaborators.$[collaborator].role': CollaboratorRole.UNLICENSED.name
            }
        },
        {
            arrayFilters: [collaboratorsQuery],
            new: true
        }
    );
    return updatedProject ?? project;
}

ProjectSchema.statics.disableCollaboratorsByTypes = async function (project, collaboratorsTypes = []) {
    const roleNames = CollaboratorRole.listNonPhantomRoles().map((role) => role.name);
    _.pull(roleNames, ...collaboratorsTypes);
    return unlicenseCollaborators(project, { 'collaborator.role': { $in: roleNames } });
};

ProjectSchema.statics.limitNumberOfCollaboratorsEnabled = async function (project, limit) {
    const licensedCollaborators =
        project.collaborators?.filter((c) => ![CollaboratorRole.UNLICENSED.name, CollaboratorRole.VIEWER.name].includes(c.role ?? '')) ??
        [];
    if (licensedCollaborators.length <= limit) {
        return project;
    }
    const collaboratorIds = licensedCollaborators.slice(limit).map((c) => c._id);
    return unlicenseCollaborators(project, { 'collaborator._id': { $in: collaboratorIds } });
};

ProjectSchema.statics.limitNumberOfViewersCollaboratorsEnabled = async function (project, limit) {
    const licensedCollaborators = project.collaborators?.filter((c) => c.role === CollaboratorRole.VIEWER.name) ?? [];
    if (licensedCollaborators.length <= limit) {
        return project;
    }
    const collaboratorIds = licensedCollaborators.slice(limit).map((c) => c._id);
    return unlicenseCollaborators(project, { 'collaborator._id': { $in: collaboratorIds } });
};

ProjectSchema.statics.startTrial = async function (project, tierId, setTrialStartedRecently?) {
    const previousTierId = project.subscription.safeTierId;
    const tierAttributes = customerTierService.getTierAttributes(tierId);
    if (!tierAttributes || !tierAttributes.isTrial || typeof tierAttributes.trialDays !== 'number') {
        throw new Error('tier is not a valid trial tier');
    }
    const { trialDays } = tierAttributes;
    const trialStartTime = new Date();
    trialStartTime.setHours(0, 0, 0, 0);
    const modifiedProject = await Project.findOneAndUpdate(
        { _id: project._id },
        {
            $set: {
                'subscription.trialStartedRecently': setTrialStartedRecently ? tierId : undefined,
                'subscription.trialEligibility': false,
                'subscription.scheduledForCancellation': false,
                'subscription.tierId': tierId,
                'subscription.endOfBillingCycle': new Date(trialStartTime.getTime() + (trialDays + 1) * 24 * 60 * 60 * 1000 - 1) // ends right before midnight of the last day
            },
            $unset: {
                'subscription.trialExpiredRecently': '',
                'subscription.paidPlanExpiredRecently': ''
            }
        },
        { new: true }
    );
    if (!modifiedProject) {
        return null;
    }
    return customerTierService.updateProjectAfterTierChange(modifiedProject, previousTierId);
};

ProjectSchema.statics.downgradePlanIfNeeded = async function (project) {
    const User = mongoose.models.User as IUserModel; // prevent dependency loop
    let modifiedProject: IProjectDoc | null = project;
    const previousTierId = modifiedProject.subscription.tierId;
    if (previousTierId && (await modifiedProject.isSubscriptionEnded())) {
        const { downgradesTo } = customerTierService.getTierAttributes(previousTierId) ?? {};
        if (downgradesTo) {
            modifiedProject = await Project.cancelSubscription(modifiedProject._id!, { immediate: true });
            if (!modifiedProject) {
                return null;
            }
            modifiedProject = await customerTierService.updateProjectAfterTierChange(modifiedProject, previousTierId);
            if (!modifiedProject) {
                return null;
            }
            await sendPlansEmail(modifiedProject, previousTierId, PLANS_EMAIL_EVENT.EXPIRED);
            if (customerTierService.getTierAttributes(previousTierId)?.isTrial) {
                const owner = await User.findById(project.ownerId);
                if (owner) {
                    analytics.track(
                        'Trial Expired',
                        {
                            projectId: modifiedProject.id,
                            tierId: previousTierId
                        },
                        owner
                    );
                }
            }
        }
    }
    return modifiedProject;
};

ProjectSchema.statics.autoDowngradeExpiredProjects = async function () {
    const tiersForAutoDowngrade = customerTierService.listTiersForAutoDowngrade();
    const projects = await Project.find({
        'subscription.tierId': { $in: tiersForAutoDowngrade }
    });
    for (const project of projects) {
        await Project.downgradePlanIfNeeded(project);
    }
};

ProjectSchema.statics.detectOutOfSyncPaidProjects = async function () {
    const paidTiers = customerTierService.listDowngradablePaidTiers();
    const projects = await Project.find({
        'subscription.tierId': { $in: paidTiers }
    });
    const outOfSyncPaidProjectIds: string[] = [];
    for (const project of projects) {
        const tierEndDate = project.subscription.endOfBillingCycle;
        if (!project.subscription.scheduledForCancellation && (!tierEndDate || Date.now() >= tierEndDate.getTime())) {
            outOfSyncPaidProjectIds.push(project.id!);
        }
    }
    if (outOfSyncPaidProjectIds.length > 0) {
        logger.info(`Out of Sync Projects: ${outOfSyncPaidProjectIds.join(', ')}`);
        analytics.anonymousTrack('Daily Out of Sync Projects', { projectIds: outOfSyncPaidProjectIds.join(', ') }, 'stackbit-api-service');
    }
};

ProjectSchema.statics.unsetSubscriptionFlag = async function (projectId, flag) {
    if (!SUBSCRIPTION_FLAGS.includes(flag)) {
        throw new Error(`unknown subscription flag: ${flag}`);
    }
    return Project.findOneAndUpdate(
        { _id: projectId },
        {
            $unset: {
                [`subscription.${flag}`]: ''
            }
        },
        { new: true }
    );
};

ProjectSchema.statics.findDeployedProjectsInLastPeriodWithViewers = async function (deployedSince) {
    return Project.find({
        deployedAt: {
            $gt: deployedSince
        },
        collaborators: {
            $elemMatch: {
                role: CollaboratorRole.VIEWER.name
            }
        }
    });
};

ProjectSchema.statics.findProjectsByWebhook = async function (type, value) {
    switch (type) {
        case 'github':
            return Project.find({ webhooks: { github: { repoName: value } } });
        default:
            throw new Error(`${type} isn't supported`);
    }
};

export type ProjectGroupsIdsKeyType = Pick<IProject, 'projectGroupIds'>;
export const PROJECT_GROUPS_IDS_KEY: keyof ProjectGroupsIdsKeyType = 'projectGroupIds';

ProjectSchema.statics.setOrganizationIdForProject = async function (projectId, orgId) {
    const org = await Organization.findOne({ _id: orgId });
    if (!org) {
        throw new ResponseError('NotFound');
    }
    const foundProject = await Project.findOneAndUpdate({ _id: projectId }, { $set: { organizationId: orgId } });
    if (!foundProject) {
        // project does not exist
        throw new ResponseError('NotFound');
    }
};

ProjectSchema.statics.addProjectToProjectGroup = async function (projectId, projectGroupId) {
    const project = await Project.findOne({ _id: projectId });
    const orgId = project?.organizationId;
    if (!orgId) {
        throw new ResponseError('NotFound');
    }
    const org = await Organization.findOne({ _id: orgId });
    const orgProjectGroupsFound = org?.projectGroups?.filter((t) => t._id?.equals(projectGroupId)).length === 1;
    if (!orgProjectGroupsFound) {
        throw new ResponseError('NotFound');
    }
    const foundProject = await Project.findOneAndUpdate({ _id: projectId }, { $addToSet: { [PROJECT_GROUPS_IDS_KEY]: projectGroupId } });
    if (!foundProject) {
        // project does not exist
        throw new ResponseError('NotFound');
    }
};

ProjectSchema.statics.removeProjectFromProjectGroup = async function (projectId, projectGroupId) {
    const orgId = (await Project.findOne({ _id: projectId }))?.organizationId;
    if (!orgId) {
        throw new ResponseError('NotFound');
    }
    const org = await Organization.findOne({ _id: orgId });
    const orgProjectGroupsFound = org?.projectGroups?.filter((t) => t._id?.equals(projectGroupId)).length === 1;
    if (!orgProjectGroupsFound) {
        throw new ResponseError('NotFound');
    }
    const updatedProject = await Project.findOneAndUpdate({ _id: projectId }, { $pull: { [PROJECT_GROUPS_IDS_KEY]: projectGroupId } });
    if (!updatedProject) {
        // project does not exist
        throw new ResponseError('NotFound');
    }
};

// Ensure virtual fields are serialised.
ProjectSchema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: function (_doc: IProjectDoc, ret: IProjectJSON & Pick<IProjectDoc, '_id'>) {
        delete ret._id;
    }
});

const Project = mongoose.model('Project', ProjectSchema.unsafeSchema);
export default Project;
