import config from '../../config';
import { sendPlansEmail, PLANS_EMAIL_EVENT } from '../customerio-service/customerio-transactional-service';
import analytics from '../analytics/analytics';
import logger from '../logger';
import { IUserDoc, IUserModel } from '../../models/user.model';
import { IProjectDoc, IProjectModel } from '../../models/project.model';
import CollaboratorRole from '../../models/collaborator-role.model';

export const DEFAULT_TIER_ID = 'developer';

export interface CustomerTier {
    name: string;
    attributes: {
        isFree: boolean,
        isTrial: boolean,
        downgradesTo?: string,
        trialTierOf?: string,
        trialDays?: number,
        openToTierIds?: string[],
        disqualifyingPastTierIds?: string[]
    };
    stripeProductId?: string;
    defaultPlan?: string;
    features?: {
        hpPreviews: boolean,
        containerMaxInactivityTimeInMinutes: number,
        wysiwyg: boolean,
        collaborators: number,
        environments: number,
        diff: boolean,
        merge: boolean,
        abTesting: boolean,
        approval: boolean,
        pageGranularity: boolean,
        verifiedPublish: boolean,
        crossPageDep: boolean,
        undo: boolean,
        scheduledPublish: boolean,
        collaboratorRoles: boolean,
        developerTools: boolean,
        settingsConnectedServices: boolean,
        settingsAdvanced: boolean,
        supportAction: string,
        hasViewerRole: boolean,
        viewersCollaborators: number
    };
    upgradeHookScheme?: string;
}

export type FeatureName = keyof NonNullable<CustomerTier['features']>;
export type CustomerTierFeatures = Partial<NonNullable<CustomerTier['features']>>;

export const SCHEMA: Record<FeatureName, any> = {
    hpPreviews: Boolean,
    containerMaxInactivityTimeInMinutes: Number,
    wysiwyg: Boolean,
    collaborators: Number,
    environments: Number,
    diff: Boolean,
    merge: Boolean,
    abTesting: Boolean,
    approval: Boolean,
    pageGranularity: Boolean,
    verifiedPublish: Boolean,
    crossPageDep: Boolean,
    undo: Boolean,
    scheduledPublish: Boolean,
    collaboratorRoles: Boolean,
    developerTools: Boolean,
    settingsConnectedServices: Boolean,
    settingsAdvanced: Boolean,
    supportAction: String,
    hasViewerRole: Boolean,
    viewersCollaborators: Number
};

const customerTiers: Record<string, CustomerTier> = config.customerTiers;

export function getDefaultTierIdForUser(user: IUserDoc): string {
    return user.features.defaultCustomerTier ?? DEFAULT_TIER_ID;
}

export function getDefaultTierForUser(user: IUserDoc): CustomerTier | undefined {
    return customerTiers[getDefaultTierIdForUser(user)];
}

export function getById(tierId: string): CustomerTier | undefined {
    return customerTiers[tierId];
}

export function getTierByProductId(productId: string): CustomerTier & { id: string } | undefined {
    const tierId = Object.keys(config.customerTiers).find(id => {
        return customerTiers[id]?.stripeProductId === productId;
    });

    if (!tierId) {
        return;
    }

    return {
        id: tierId,
        ...(customerTiers[tierId]!)
    };
}

export function getPaidTierIdOfTrial(tierId: string): string | undefined {
    const tier = customerTiers[tierId];
    if (tier?.attributes.isTrial) {
        return tier.attributes.trialTierOf;
    }
}

export function getPaidTierOfTrial(tierId: string): CustomerTier | undefined {
    const paidTierId = getPaidTierIdOfTrial(tierId);
    if (paidTierId) {
        return customerTiers[paidTierId];
    }
}

export function getPaidTierNameOfTrial(tierId: string): string | undefined {
    return getPaidTierOfTrial(tierId)?.name;
}

export function getTierFeatures(tierId: string, overrides: CustomerTierFeatures = {}): CustomerTierFeatures | undefined {
    const tier = customerTiers[tierId];
    if (!tier) {
        return;
    }
    const paidTier = getPaidTierOfTrial(tierId);
    const sanitizedOverrides = (Object.keys(SCHEMA) as FeatureName[]).reduce((result: CustomerTierFeatures, key) => {
        if (overrides[key] === undefined) {
            return result;
        }
        return {
            ...result,
            [key]: overrides[key]
        };
    }, {});

    return {
        ...(paidTier?.features ?? {}),
        ...tier.features,
        ...sanitizedOverrides
    };
}

type TierHook = {
    trialTiers: {
        id: string,
        name?: string,
        paidTierName?: string
    }[]
};

export type TierHooks = Record<string, TierHook>;

export function getTierHooks(tierId: string): TierHooks {
    const tier = customerTiers[tierId];
    const paidTier = getPaidTierOfTrial(tierId);
    const upgradeHookScheme = paidTier?.upgradeHookScheme ?? tier?.upgradeHookScheme;
    const hooks = config.upgradeHookSchemes[upgradeHookScheme!];
    if (!hooks) {
        return {};
    }
    // The type annotations here are added to work when `config: any`, which happens during config building.
    return Object.fromEntries(
        Object.entries(hooks).map(([name, settings]: [string, typeof hooks extends Record<string, infer S> ? S : any]) => [
            name,
            {
                ...settings,
                trialTiers: settings.trialTiers.map((trialTier: (typeof settings.trialTiers)[number]) => {
                    const trialTierName = getTierName(trialTier.id);
                    const paidTier = getPaidTierOfTrial(trialTier.id);
                    return {
                        ...trialTier,
                        name: trialTierName,
                        paidTierName: paidTier?.name
                    };
                })
            }
        ])
    );
}

export function getTierName(tierId: string): string | undefined {
    return customerTiers[tierId]?.name;
}

export function getTierAttributes(tierId: string): CustomerTier['attributes'] | undefined {
    return customerTiers[tierId]?.attributes;
}

export function isFreeTier(tierId: string): boolean {
    const attributes = getTierAttributes(tierId);
    return attributes?.isFree ?? false;
}

export function isTrialTier(tierId: string): boolean {
    const attributes = getTierAttributes(tierId);
    return attributes?.isTrial ?? false;
}

export function isDowngradableTier(tierId: string): boolean {
    const attributes = getTierAttributes(tierId);
    return !!attributes?.downgradesTo;
}

export function listTiersForAutoDowngrade(): string[] {
    return Object.keys(customerTiers)
        .filter((tierId) => isDowngradableTier(tierId));
}

export function listDowngradablePaidTiers(): string[] {
    return Object.keys(customerTiers)
        .filter((tierId) => isDowngradableTier(tierId) && !isFreeTier(tierId) && !isTrialTier(tierId));
}

export function isEligibleForTrial(tierId: string, project: IProjectDoc): boolean {
    const attributes = getTierAttributes(tierId);
    if (!attributes) {
        return false;
    }
    if (project.subscription.tierId === tierId) {
        return true;
    }
    if (!attributes.openToTierIds?.includes(project.subscription.tierId!)) {
        return false;
    }
    if (!attributes.disqualifyingPastTierIds) {
        return true;
    }
    return attributes.disqualifyingPastTierIds.every(tierId => !project.subscription.pastTierIds.includes(tierId));
}

export type CustomerTierTrialWithEligibility = {
    id: string,
    paidTierId?: string,
    eligible: boolean
};

export function listTrialsWithEligibility(project: IProjectDoc): CustomerTierTrialWithEligibility[] {
    return Object.entries(customerTiers)
        .filter(([_tierId, tier]) => tier.attributes.isTrial)
        .map(([tierId, _tier]) => ({
            id: tierId,
            paidTierId: getPaidTierIdOfTrial(tierId),
            eligible: isEligibleForTrial(tierId, project)
        }));
}

export async function updateProjectAfterTierChange(project: IProjectDoc, previousTierId: string): Promise<IProjectDoc | null> {
    const User: IUserModel = require('../../models/user.model').default;
    const Project: IProjectModel = require('../../models/project.model').default;
    const { cleanupSplitTest } = require('../deploy-services/split-test-service');

    logger.info(`Project tier change, ${project.id}, from ${previousTierId} to ${project.subscription.safeTierId}`);

    project = (await Project.addCurrentTierToPastTiers(project))!;

    const previousFeatures = getTierFeatures(previousTierId, project.subscription.tierOverrides) ?? {};
    const currentFeatures = project.getCustomerTier().features ?? {};

    if (!currentFeatures.collaboratorRoles && previousFeatures.collaboratorRoles) {
        project = await Project.disableCollaboratorsByTypes(project, [CollaboratorRole.EDITOR.name, CollaboratorRole.DEVELOPER.name]);
    }

    if (!currentFeatures.hasViewerRole && previousFeatures.hasViewerRole) {
        project = await Project.disableCollaboratorsByTypes(project, [CollaboratorRole.VIEWER.name]);
    }

    project = await Project.limitNumberOfCollaboratorsEnabled(project, currentFeatures.collaborators ?? 0);
    project = await Project.limitNumberOfViewersCollaboratorsEnabled(project, currentFeatures.viewersCollaborators ?? 0);
    const user = await User.findUserById(project.ownerId!);

    if (!currentFeatures.abTesting && project.splitTests[0]?.status === 'provisioned') {
        project = await cleanupSplitTest(project, user);
    }

    if (project.subscription.tierId && previousTierId !== project.subscription.tierId) {
        await sendPlansEmail(project, project.subscription.tierId, PLANS_EMAIL_EVENT.STARTED);
        const { isFree, isTrial } = getTierAttributes(project.subscription.safeTierId) ?? {};
        if (!isFree && !isTrial) {
            analytics.track('Subscription Purchased', {
                projectId: project.id,
                userId: user?.id,
                userEmail: user?.email,
                tierId: project.subscription.tierId,
                projectUrl: project.siteUrl
            }, user);
        }
    }

    return project;
}
