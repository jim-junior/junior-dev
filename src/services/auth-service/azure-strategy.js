const AzureStrategy = require('passport-azure-ad').OIDCStrategy;
const _ = require('lodash');
const authStrategy = require('./auth-strategy');
const config = require('../../config').default;
const logger = require('../../services/logger');

const serverConfig = config.server;
const azureConfig = config.azure;
const AZURE_CALLBACK_URL = `${serverConfig.hostname}/auth/azure/callback`;
const identityMetadataUrl = new URL('common/v2.0/.well-known/openid-configuration', azureConfig.loginUrl);

const baseAzureConfig = {
    identityMetadata: identityMetadataUrl.toString(),
    clientID: azureConfig.clientId,
    redirectUrl: AZURE_CALLBACK_URL,
    clientSecret: azureConfig.clientSecret,
    scope: ['openid', 'offline_access', 'profile', 'email', 'https://management.core.windows.net/user_impersonation'],
    passReqToCallback: true,
    responseType: 'id_token code',
    responseMode: 'form_post',
    loggingLevel: 'info',
    // it’s not much of a problem, since the token signature will prove the issuer identity anyway
    // more - https://thomaslevesque.com/2018/12/24/multitenant-azure-ad-issuer-validation-in-asp-net-core/  if there intention to implement issuer validation
    validateIssuer: false,
};

/**
 * Note 1:
 * There's no way to define token lifetime period
 * https://github.com/AzureAD/passport-azure-ad/issues/325
 *
 * Note 2:
 * refresh doesn't work with Azure OIDC strategy
 * https://github.com/fiznool/passport-oauth2-refresh/issues/27
 */
module.exports = new AzureStrategy(baseAzureConfig, (req, iss, sub, profile, access_token, refresh_token, done) => {
    let userProfile;
    const azureProfile = _.get(profile, '_json');

    userProfile = {
        id: azureProfile.tid,
        emails: [{ value: azureProfile.email }]
    };

    // Azure strategy don't pass req.query.state
    // Azure auth has "customState" coming from req.body
    req.query.state = _.get(req, 'body.state');

    return authStrategy('azure',  { mustAgreeTos: true, forceConnectionOnly: true }, req, access_token, refresh_token, userProfile, (async (param, user) => {
        if (user) {
            const connections = _.get(user, 'connections', []);
            const connection = connections.find(con => con.type === 'azure');
            if (connection) {
                // update user connection settings
                user = await user.addConnection('azure', {
                    settings: {
                        tenantIdOrName: azureProfile.tid
                    }
                });
            }
        } else {
            logger.debug('[Azure AuthStrategy] no user to connect', { profile: userProfile, requestBody: req.body });
        }
        return done(param, user);
    }));
});
