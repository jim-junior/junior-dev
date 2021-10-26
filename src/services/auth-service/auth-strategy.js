const _ = require('lodash');
const User = require('../../models/user.model').default;
const logger = require('../../services/logger');
const analytics = require('../../services/analytics/analytics');
const ResponseErrors = require('../../routers/response-errors');
const querystring = require('querystring');

const authStrategy = (strategyType, { mustAgreeTos = true, alwaysAllowConnectionOnly = false, forceConnectionOnly = false, addToUserGroup = false }, req, accessToken, refreshToken, profile, done) => {
    const state = querystring.parse(decodeURI(req.query.state));
    const authName = _.get(strategyType, 'auth', strategyType);
    const connectionName = _.get(strategyType, 'connection', strategyType);
    const tosVersion = _.get(state, 'tosVersion', req.query.tosVersion);
    const userGroup = _.get(state, 'userGroup', req.query.userGroup);
    let initialReferrer = null;
    try {
        initialReferrer = JSON.parse(_.get(state, 'initialReferrer', req.query.initialReferrer) || null);
    } catch(err) {
        logger.error('[AuthStrategy] Failed to parse initial referrer data', {strategyType, userId: _.get(req, 'user.id'), rawState: req.query.state, fromState: _.get(state, 'initialReferrer'), fromQuery: req.query.initialReferrer, err});
    }
    const allowConnectionOnly = alwaysAllowConnectionOnly || _.get(state, 'allowConnectionOnly', req.query.allowConnectionOnly);
    const providerEmailObj = _.find(profile.emails, { primary: true }) || _.get(profile, 'emails[0]');
    const providerEmail = _.get(providerEmailObj, 'value');
    const authLoggerObject = {
        authName,
        profile: profile,
        reqUserId: _.get(req, 'user.id'),
        isTemporaryUser: _.get(req, 'user.temporary'),
        tosVersion,
        mustAgreeTos,
        addToUserGroup,
        reqAllowConnectionOnly: _.get(state, 'allowConnectionOnly', req.query.allowConnectionOnly),
        alwaysAllowConnectionOnly,
        providerEmail
    };

    const addProviderAndConnection = (dbUser, connectionOnly = false) => {
        if (!connectionOnly && profile.id && _.get(dbUser, `authProviders.${authName}`) && _.get(dbUser, `authProviders.${authName}.providerUserId`) !== profile.id) {
            throw ResponseErrors.ProviderIdCannotBeChanged;
        }

        let promise = Promise.resolve(dbUser);
        if (profile.id && !_.get(dbUser, `authProviders.${authName}`) && !connectionOnly && !forceConnectionOnly) {
            promise = dbUser.addGenericAuthProvider(authName, profile.id, profile);
        }

        return promise.then(dbUser => {
            return dbUser.addConnection(connectionName, {
                accessToken,
                refreshToken,
                connectionUserId: profile.id,
                connectionUserEmail: providerEmail
            });
        });
    };

    const registerFlow = async dbUser => {
        let createdUserId = null;

        if (!dbUser) {
            dbUser = User.createUser().then(createdUser=> {
                createdUserId = createdUser._id;
                return createdUser;
            });
        }

        return Promise.resolve(dbUser)
            .then(dbUser => (tosVersion ? dbUser.agreeToTosVersion(tosVersion) : dbUser))
            .then(dbUser => (addToUserGroup ? dbUser.setGroup(userGroup) : dbUser))
            .then(dbUser => (initialReferrer ? dbUser.setUserInitialReferrer(initialReferrer) : dbUser))
            .then(dbUser => addProviderAndConnection(dbUser))
            .then(dbUser => {
                analytics.track('User Registered', { userId: dbUser.id, type: connectionName }, dbUser);
                return dbUser;
            }).catch(err=>{
                if (createdUserId) {
                    logger.error(`[AuthStrategy] ${authName} strategy failed to register user`, { error: err, profile: profile, requestBody: req.body, authLoggerObject });
                    return User.deleteUserById(createdUserId).then(()=> { throw err; });
                }
            });
    };

    return Promise.all([User.findUserByProviderId(authName, profile.id), User.findUserByEmail(providerEmail)])
        .then(([dbProviderUser, dbEmailUser]) => {
            authLoggerObject.dbProviderUserId = _.get(dbProviderUser, 'id');
            authLoggerObject.dbPrimaryEmailUserId = _.get(dbEmailUser, 'id');
            const dbStrategyUser = dbProviderUser || dbEmailUser;
            if (!req.user) {
                if (dbStrategyUser) {
                    // User found updating provider + connection
                    analytics.track('[AuthStrategy] Anonymous user signed into an existing user', authLoggerObject, dbStrategyUser);
                    return addProviderAndConnection(dbStrategyUser);
                }

                if (mustAgreeTos && (!tosVersion && !allowConnectionOnly)) {
                    throw ResponseErrors.MustAgreeToTOS;
                }

                // else new user
                analytics.anonymousTrack('[AuthStrategy] Anomymous user registered', authLoggerObject, req.cookies.ajs_anonymous_id);
                return registerFlow();
            } else if (req.user) {
                if (dbStrategyUser && dbStrategyUser.id !== req.user.id) {
                    if (allowConnectionOnly) {
                        analytics.track('[AuthStrategy] Logged In User added only connection because provider was taken', authLoggerObject, req.user);
                        return addProviderAndConnection(req.user, true);
                    }

                    analytics.track('[AuthStrategy] Logged In User tried to add a taken provider', authLoggerObject, req.user);
                    throw ResponseErrors.ProviderInUseError;
                }
                analytics.track('[AuthStrategy] Logged In User added provider', authLoggerObject, req.user);
                return addProviderAndConnection(req.user);
            }
        })
        .then(dbUser => done(null, dbUser))
        .catch(err => {
            if (err.name === 'MustAgreeToTOS') {
                logger.warn(`[AuthStrategy] ${authName} strategy warning`, { error: err, profile: profile, requestBody: req.body, authLoggerObject });
            } else {
                console.log(err);
                logger.error(`[AuthStrategy] ${authName} strategy failure`, { error: err, profile: profile, requestBody: req.body, authLoggerObject });
            }
            return done(err);
        });
};

module.exports = authStrategy;
