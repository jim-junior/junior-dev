import config from '../../config';

export const DEFAULT_GROUP_ID = 'regular';
export const DEFAULT_GROUP = config.userGroups[DEFAULT_GROUP_ID]!; // unsafe

export interface ISchema {
    trialDaysFromCreation?: number;
    projectDeploymentShowSurvey?: boolean;
    projectDeploymentShowVerifyEmail?: boolean;
    settingsConnectDomainCard?: boolean;
    settingsManageSubscriptionCard?: boolean;
    publishPopupShowBetaInfo?: boolean;
    supportEmail?: string;
    defaultCustomerTier?: string;
}

export const SCHEMA = {
    trialDaysFromCreation: Number,
    projectDeploymentShowSurvey: Boolean,
    projectDeploymentShowVerifyEmail: Boolean,
    settingsConnectDomainCard: Boolean,
    settingsManageSubscriptionCard: Boolean,
    publishPopupShowBetaInfo: Boolean,
    supportEmail: String,
    defaultCustomerTier: String
};

export function getById(groupId: string) {
    return config.userGroups[groupId];
}

export function getGroupFeatures(groupId: string, overrides: ISchema = {}): ISchema {
    const group = config.userGroups[groupId] || DEFAULT_GROUP;
    const sanitizedOverrides = (Object.keys(SCHEMA) as (keyof typeof SCHEMA)[]).reduce((result, key) => {
        if (overrides[key] === undefined) {
            return result;
        }

        return {
            ...result,
            [key]: overrides[key]
        };
    }, {});

    return {
        ...group.features,
        ...sanitizedOverrides
    };
}
