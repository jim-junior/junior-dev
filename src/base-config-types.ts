// This file was automatically generated together with base-config.ts

const config = {} as any;

export type BaseConfig = {
    "env": string,
    "server": {
        "hostname": string,
        "corsOrigin": string[],
        "clientOrigin": string,
        "netlifyAppDomain": string,
        "webhookHostname": string
    },
    "features": {
        "pullUseLambda": boolean,
        "devtoWebhook": boolean,
        "secretsManager": boolean,
        "containerHibernation": boolean,
        "adminHeapdump": boolean,
        "studio": boolean,
        "schemalessContainer": boolean,
        "advancedContentLoaderContainer": boolean,
        "studioCodeEditor": boolean,
        "localContainerMode": boolean,
        "outputLocalContainerLogs": boolean,
        "forceUpdateContainerUrl": boolean
    },
    "mailgun": {
        "domain": string,
        "sendVerificationEmailOnSignup": boolean,
        "fromAddress": string,
        "sendToTestAccount": boolean,
        "testAccount": string
    },
    "mongo": {
        "url": string,
        "host": string
    },
    "container": {
        "env": string,
        "snippetUrl": string,
        "internalUrl": string,
        "bucket": string,
        "fastly": {
            "apiBaseUrl": string,
            "spaceId": string
        },
        "router": {
            "url": string
        },
        "shared": {
            "projectsGithubUsername": string,
            "projectsGithubEmail": string,
            "projectsGithubUser": string,
            "logs": {
                "groupName": string,
                "streamNamePrefix": string,
                "fetchLimit": number,
                "initialFetchLimit": number
            },
            "genericTaskDefinition": string,
            "prepackagedTaskDefinitions": {
                "gatsby": string,
                "nextjs": string
            },
            "taskDetails": {
                "cluster": string,
                "taskDefinition": string
            }
        }
    },
    "github": {
        "orgName": string,
        "privateRepos": boolean,
        "appId": string,
        "appInstallUrl": string
    },
    "google": {
        "defaultScopes": string[],
        "allowedScopes": string[]
    },
    "build": {
        "buildApiBaseUrl": string,
        "themesBaseUrl": string,
        "adminBaseUrl": string,
        "stackbitWidget": {
            "enabled": boolean,
            "widgetUrl": string
        },
        "stackbitWidgetForImportedSites": {
            "enabled": boolean
        },
        "handcraftedNextjsThemes": {
            "https://github.com/stackbit-themes/starter-unibit": string,
            "https://github.com/stackbit-themes/diy-unibit": string,
            "https://github.com/stackbit-themes/azimuth-unibit": string,
            "https://github.com/stackbit-themes/exto-unibit": string,
            "https://github.com/stackbit-themes/ampersand-unibit": string,
            "https://github.com/stackbit-themes/fjord-unibit": string,
            "https://github.com/stackbit-themes/libris-unibit": string,
            "https://github.com/stackbit-themes/vanilla-unibit": string,
            "https://github.com/stackbit-themes/fresh-unibit": string,
            "https://github.com/stackbit-themes/personal-unibit": string,
            "https://github.com/stackbit-themes/agency-unibit": string,
            "https://github.com/stackbit-themes/startup-unibit": string,
            "https://github.com/stackbit-themes/app-unibit": string,
            "https://github.com/stackbit-themes/event-unibit": string,
            "https://github.com/stackbit-themes/book-unibit": string,
            "https://github.com/stackbit-themes/podcaster-unibit": string
        }
    },
    "contentful": {
        "authorizationURL": string,
        "tokenURL": string,
        "profileURL": string
    },
    "datocms": {
        "authorizationURL": string,
        "tokenURL": string,
        "profileURL": string
    },
    "devto": {
        "authorizationURL": string,
        "tokenURL": string,
        "profileURL": string
    },
    "forestry": {
        "apiEnabled": boolean,
        "authorizationURL": string,
        "tokenURL": string,
        "profileURL": string
    },
    "netlify": {
        "authorizationURL": string,
        "tokenURL": string,
        "anonAccountSlug": string,
        "anonFlowEnabled": boolean,
        "shared": {
            "accountSlug": string,
            "domain": string
        }
    },
    "azure": {
        "anonFlowEnabled": boolean,
        "starterRepoUrl": string,
        "loginUrl": string,
        "resourceManagementUrl": string
    },
    "digitalocean": {
        "userProfileURL": string,
        "userAppsURL": string
    },
    "importer": {
        "medium": {
            "bucket": string
        }
    },
    "jobox": {
        "userId": string,
        "internalUrl": string,
        "siteUrlBase": string
    },
    "segment": {
        "workspace": string
    },
    "logging": {
        "level": string,
        "morganFormat": string
    },
    "sentry": {
        "dsn": string
    },
    "crisp": {
        "enabled": boolean,
        "websiteId": string
    },
    "stackbitFactory": {
        "useLocal": boolean,
        "localPath": string,
        "installFolder": string,
        "includePrerelease": boolean,
        "prereleaseTags": (null | string[])
    },
    "assetUpload": {
        "bucket": string
    },
    "customerTiers": {
        "beta": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "developer": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "pro": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "business": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "enterprise": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "nocode": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "2021a-free": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "2021a-pro": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean,
                "downgradesTo": string
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "2021a-business": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean,
                "downgradesTo": string
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "2021a-pro-trial": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean,
                "trialTierOf": string,
                "trialDays": number,
                "downgradesTo": string,
                "openToTierIds": string[],
                "disqualifyingPastTierIds": string[]
            }
        },
        "2021a-business-trial": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean,
                "trialTierOf": string,
                "trialDays": number,
                "downgradesTo": string,
                "openToTierIds": string[],
                "disqualifyingPastTierIds": string[]
            }
        }
    },
    "upgradeHookSchemes": {
        "2021a": {
            "splitTesting": {
                "trialTiers": {
                    "id": string
                }[]
            },
            "granularPublishing": {
                "trialTiers": {
                    "id": string
                }[]
            },
            "scheduledPublishing": {
                "trialTiers": {
                    "id": string
                }[]
            },
            "collaborators": {
                "trialTiers": {
                    "id": string
                }[]
            },
            "collaboratorRoles": {
                "trialTiers": {
                    "id": string
                }[]
            }
        }
    },
    "userGroups": {
        "regular": {
            "features": {
                "projectDeploymentShowSurvey": boolean,
                "projectDeploymentShowVerifyEmail": boolean,
                "settingsConnectDomainCard": boolean,
                "settingsManageSubscriptionCard": boolean,
                "publishPopupShowBetaInfo": boolean,
                "supportEmail": string,
                "defaultCustomerTier": string
            }
        },
        "nocode": {
            "features": {
                "trialDaysFromCreation": number,
                "simplifiedUI": boolean,
                "projectDeploymentShowSurvey": boolean,
                "projectDeploymentShowVerifyEmail": boolean,
                "settingsConnectDomainCard": boolean,
                "settingsManageSubscriptionCard": boolean,
                "publishPopupShowBetaInfo": boolean,
                "supportEmail": string,
                "defaultCustomerTier": string
            }
        }
    },
    "scheduledPublish": {
        "lambdaArn": string
    },
    "slack": {
        "sendNotifications": boolean,
        "mongoBackupWebhookId": string,
        "leadsCustomTheme": string,
        "leadsImportSite": string
    },
    "insights": {
        "netlifyAnalyticsBaseUrl": string,
        "netlifyWidgetSiteId": string
    },
    "analyticsDb": {
        "url": string
    },
    "customer": {
        "transactionalMessages": {
            "requestPublish": number,
            "requestedPublishDone": number,
            "publishNotificationForViewers": number,
            "inviteCollaborator": number,
            "contactForm": number,
            "plans": {
                "2021a-pro-trial": {
                    "started": number
                },
                "2021a-pro": {
                    "started": number,
                    "cancelled": number
                },
                "2021a-business-trial": {
                    "started": number
                },
                "2021a-business": {
                    "started": number,
                    "cancelled": number
                }
            },
            "importEnquiry": number
        }
    },
    "v2themes": string[],
    "v2deployments": string[]
};

export type Config = {
    "env": string,
    "server": {
        "hostname": string,
        "corsOrigin": string[],
        "clientOrigin": string,
        "netlifyAppDomain": string,
        "webhookHostname": string,
        "jwtSecret"?: string,
        "containerSecret"?: string,
        "joboxContainerSecret"?: string
    },
    "features": {
        "pullUseLambda": boolean,
        "devtoWebhook": boolean,
        "secretsManager": boolean,
        "containerHibernation": boolean,
        "adminHeapdump": boolean,
        "studio": boolean,
        "schemalessContainer": boolean,
        "advancedContentLoaderContainer": boolean,
        "studioCodeEditor": boolean,
        "localContainerMode": boolean,
        "outputLocalContainerLogs": boolean,
        "forceUpdateContainerUrl": boolean
    },
    "mailgun": {
        "domain": string,
        "sendVerificationEmailOnSignup": boolean,
        "fromAddress": string,
        "sendToTestAccount": boolean,
        "testAccount": string,
        "apiKey"?: string
    },
    "mongo": {
        "url": string,
        "host": string
    },
    "container": {
        "env": string,
        "snippetUrl": string,
        "internalUrl": string,
        "bucket": string,
        "fastly": {
            "apiBaseUrl": string,
            "spaceId": string,
            "purgeToken"?: string
        },
        "router": {
            "url": string
        },
        "shared": {
            "projectsGithubUsername": string,
            "projectsGithubEmail": string,
            "projectsGithubUser": string,
            "logs": {
                "groupName": string,
                "streamNamePrefix": string,
                "fetchLimit": number,
                "initialFetchLimit": number
            },
            "genericTaskDefinition": string,
            "prepackagedTaskDefinitions": {
                "gatsby": string,
                "nextjs": string
            },
            "taskDetails": {
                "cluster": string,
                "taskDefinition": string
            },
            "githubAccessToken"?: string,
            "themesGithubAccessToken"?: string
        }
    },
    "github": {
        "orgName": string,
        "privateRepos": boolean,
        "appId": string,
        "appInstallUrl": string,
        "clientId"?: string,
        "clientSecret"?: string,
        "appAuthorizationHeader"?: string,
        "appClientId"?: string,
        "appClientSecret"?: string,
        "publicPersonalAccessToken"?: string
    },
    "google": {
        "defaultScopes": string[],
        "allowedScopes": string[],
        "appClientId"?: string,
        "appClientSecret"?: string
    },
    "build": {
        "buildApiBaseUrl": string,
        "themesBaseUrl": string,
        "adminBaseUrl": string,
        "stackbitWidget": {
            "enabled": boolean,
            "widgetUrl": string
        },
        "stackbitWidgetForImportedSites": {
            "enabled": boolean
        },
        "handcraftedNextjsThemes": {
            "https://github.com/stackbit-themes/starter-unibit": string,
            "https://github.com/stackbit-themes/diy-unibit": string,
            "https://github.com/stackbit-themes/azimuth-unibit": string,
            "https://github.com/stackbit-themes/exto-unibit": string,
            "https://github.com/stackbit-themes/ampersand-unibit": string,
            "https://github.com/stackbit-themes/fjord-unibit": string,
            "https://github.com/stackbit-themes/libris-unibit": string,
            "https://github.com/stackbit-themes/vanilla-unibit": string,
            "https://github.com/stackbit-themes/fresh-unibit": string,
            "https://github.com/stackbit-themes/personal-unibit": string,
            "https://github.com/stackbit-themes/agency-unibit": string,
            "https://github.com/stackbit-themes/startup-unibit": string,
            "https://github.com/stackbit-themes/app-unibit": string,
            "https://github.com/stackbit-themes/event-unibit": string,
            "https://github.com/stackbit-themes/book-unibit": string,
            "https://github.com/stackbit-themes/podcaster-unibit": string
        },
        "themesPAK"?: string
    },
    "contentful": {
        "authorizationURL": string,
        "tokenURL": string,
        "profileURL": string,
        "clientId"?: string,
        "clientSecret"?: string
    },
    "datocms": {
        "authorizationURL": string,
        "tokenURL": string,
        "profileURL": string,
        "clientId"?: string,
        "clientSecret"?: string
    },
    "devto": {
        "authorizationURL": string,
        "tokenURL": string,
        "profileURL": string,
        "clientId"?: string,
        "clientSecret"?: string
    },
    "forestry": {
        "apiEnabled": boolean,
        "authorizationURL": string,
        "tokenURL": string,
        "profileURL": string,
        "clientId"?: string,
        "clientSecret"?: string
    },
    "netlify": {
        "authorizationURL": string,
        "tokenURL": string,
        "anonAccountSlug": string,
        "anonFlowEnabled": boolean,
        "shared": {
            "accountSlug": string,
            "domain": string,
            "clientId"?: string,
            "clientSecret"?: string,
            "accessToken"?: string
        },
        "clientId"?: string,
        "clientSecret"?: string,
        "anonClientId"?: string,
        "anonClientSecret"?: string,
        "anonAccessToken"?: string
    },
    "azure": {
        "anonFlowEnabled": boolean,
        "starterRepoUrl": string,
        "loginUrl": string,
        "resourceManagementUrl": string,
        "clientId"?: string,
        "clientSecret"?: string,
        "tenantId"?: string,
        "applicationId"?: string
    },
    "digitalocean": {
        "userProfileURL": string,
        "userAppsURL": string,
        "clientID"?: string,
        "clientSecret"?: string
    },
    "importer": {
        "medium": {
            "bucket": string
        }
    },
    "jobox": {
        "userId": string,
        "internalUrl": string,
        "siteUrlBase": string
    },
    "segment": {
        "workspace": string,
        "writeKey"?: string,
        "deleteToken"?: string
    },
    "logging": {
        "level": string,
        "morganFormat": string,
        "logentries"?: {
            "token": string
        },
        "loggly"?: {
            "token": string
        }
    },
    "sentry": {
        "dsn": string
    },
    "crisp": {
        "enabled": boolean,
        "websiteId": string,
        "tokenId"?: string,
        "tokenKey"?: string
    },
    "stackbitFactory": {
        "useLocal": boolean,
        "localPath": string,
        "installFolder": string,
        "includePrerelease": boolean,
        "prereleaseTags": (null | string[])
    },
    "assetUpload": {
        "bucket": string
    },
    "customerTiers": {
        "beta": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "developer": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "pro": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "business": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "enterprise": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "nocode": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "2021a-free": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean
            },
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "2021a-pro": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean,
                "downgradesTo": string
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "2021a-business": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean,
                "downgradesTo": string
            },
            "stripeProductId": string,
            "defaultPlan": string,
            "features": {
                "hpPreviews": boolean,
                "containerMaxInactivityTimeInMinutes": number,
                "wysiwyg": boolean,
                "collaborators": number,
                "environments": number,
                "diff": boolean,
                "merge": boolean,
                "abTesting": boolean,
                "approval": boolean,
                "pageGranularity": boolean,
                "verifiedPublish": boolean,
                "crossPageDep": boolean,
                "undo": boolean,
                "scheduledPublish": boolean,
                "collaboratorRoles": boolean,
                "developerTools": boolean,
                "settingsConnectedServices": boolean,
                "settingsAdvanced": boolean,
                "supportAction": string,
                "hasViewerRole": boolean,
                "viewersCollaborators": number
            },
            "upgradeHookScheme": string
        },
        "2021a-pro-trial": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean,
                "trialTierOf": string,
                "trialDays": number,
                "downgradesTo": string,
                "openToTierIds": string[],
                "disqualifyingPastTierIds": string[]
            }
        },
        "2021a-business-trial": {
            "name": string,
            "attributes": {
                "isFree": boolean,
                "isTrial": boolean,
                "trialTierOf": string,
                "trialDays": number,
                "downgradesTo": string,
                "openToTierIds": string[],
                "disqualifyingPastTierIds": string[]
            }
        }
    },
    "upgradeHookSchemes": {
        "2021a": {
            "splitTesting": {
                "trialTiers": {
                    "id": string
                }[]
            },
            "granularPublishing": {
                "trialTiers": {
                    "id": string
                }[]
            },
            "scheduledPublishing": {
                "trialTiers": {
                    "id": string
                }[]
            },
            "collaborators": {
                "trialTiers": {
                    "id": string
                }[]
            },
            "collaboratorRoles": {
                "trialTiers": {
                    "id": string
                }[]
            }
        }
    },
    "userGroups": {
        "regular": {
            "features": {
                "projectDeploymentShowSurvey": boolean,
                "projectDeploymentShowVerifyEmail": boolean,
                "settingsConnectDomainCard": boolean,
                "settingsManageSubscriptionCard": boolean,
                "publishPopupShowBetaInfo": boolean,
                "supportEmail": string,
                "defaultCustomerTier": string
            }
        },
        "nocode": {
            "features": {
                "trialDaysFromCreation": number,
                "simplifiedUI": boolean,
                "projectDeploymentShowSurvey": boolean,
                "projectDeploymentShowVerifyEmail": boolean,
                "settingsConnectDomainCard": boolean,
                "settingsManageSubscriptionCard": boolean,
                "publishPopupShowBetaInfo": boolean,
                "supportEmail": string,
                "defaultCustomerTier": string
            }
        }
    },
    "scheduledPublish": {
        "lambdaArn": string
    },
    "slack": {
        "sendNotifications": boolean,
        "mongoBackupWebhookId": string,
        "leadsCustomTheme": string,
        "leadsImportSite": string
    },
    "insights": {
        "netlifyAnalyticsBaseUrl": string,
        "netlifyWidgetSiteId": string,
        "netlifyWidgetSiteAccessToken"?: string
    },
    "analyticsDb": {
        "url": string
    },
    "customer": {
        "transactionalMessages": {
            "requestPublish": number,
            "requestedPublishDone": number,
            "publishNotificationForViewers": number,
            "inviteCollaborator": number,
            "contactForm": number,
            "plans": {
                "2021a-pro-trial": {
                    "started": number
                },
                "2021a-pro": {
                    "started": number,
                    "cancelled": number
                },
                "2021a-business-trial": {
                    "started": number
                },
                "2021a-business": {
                    "started": number,
                    "cancelled": number
                }
            },
            "importEnquiry": number
        },
        "siteId"?: string,
        "apiKey"?: string,
        "appApiKey"?: string,
        "cliTelemetryApiKey"?: string
    },
    "v2themes": string[],
    "v2deployments": string[],
    "sanity"?: {
        "clientId": string,
        "clientSecret": string
    },
    "admin"?: {
        "token": string
    },
    "stripe"?: {
        "secretKey": string,
        "webhookSigningSecret": string
    },
    "snapshotsMongo"?: {
        "url": string
    },
    "project"?: {
        "jwtSecret": string
    }
};

export default (config as BaseConfig);
