const url = require('url');
const querystring = require('querystring');
const _ = require('lodash');
const MicrosoftGraph = require('@microsoft/microsoft-graph-client');
const config = require('../../config').default;
const User = require('../../models/user.model').default;
const Project = require('../../models/project.model').default;
const EmailValidation = require('../../models/email-validation.model').default;
const UserService = require('../../services/user-services/user-service');
const MailgunService = require('../../services/mailgun-service/mailgun-service');
const analytics = require('../../services/analytics/analytics');
const ResponseErrors = require('../../routers/response-errors');
const logger = require('../../services/logger');
const DevToService = require('../../services/devto-services/devto-service');
const ForestryService = require('../../services/deploy-services/cmss/forestry');
const SanityService = require('../../services/sanity-services/sanity-service'); //TODO move to separate package
const azureService = require('../../services/azure-services/azure-service');

module.exports = {
    register: async (req, res, next) => {
        logger.debug('[register] Registering user...');
        logger.debug(`[register] req.user: ${req.user}`);
        try {
            const { email, tosVersion, password, redirect, userGroup, initialReferrer } = req.body;
            // Check if the email already exists in another user `authProviders.email.providerUserId`
            await User.findUserByProviderId('email', email).then(foundUser => {
                if (foundUser) {
                    throw ResponseErrors.RegisterEmailTaken;
                }
            });

            // Check if user accepted terms of service
            if (!tosVersion) {
                throw ResponseErrors.MustAgreeToTOS;
            }

            // Check if user is already a *logged in* user
            if (req.user) {
                throw ResponseErrors.RegisterLoggedInError;
            }

            let user = await User.createUser();

            user = await user.agreeToTosVersion(req.body.tosVersion);
            let validation = await EmailValidation.createEmailValidation(user, email, password);
            user = await user.setEmailVerificationStatus('pending', validation);
            user = await user.setUserInitialReferrer(initialReferrer);

            // add user to group if any
            if (userGroup) {
                user = await user.setGroup(userGroup);
            }

            // Verify Invited user via email
            if (redirect) {
                const parsedUrl = url.parse(redirect);
                const match = parsedUrl.pathname.match(/\/project\/(.*)\//);
                const projectId = _.get(match, '1');

                if (projectId) {
                    const parsedQs = querystring.parse(parsedUrl.query);
                    const project = await Project.findProjectById(projectId);
                    const collaborator = _.find(project.collaborators, {inviteEmail: email, inviteToken: parsedQs.token});
                    if (collaborator) {
                        user = await User.addEmailAuthProvider(validation);
                    }
                } else {
                    await MailgunService.sendValidationEmail(req.body.email, validation.validationToken);
                }
            } else {
                await MailgunService.sendValidationEmail(req.body.email, validation.validationToken);
            }

            req.login(user, (err) => {
                if (err) { return next(err); }
                logger.debug('[register] logging in...');
                analytics.identify(user, req);
                analytics.track('User Registered', {userId: user.id, type: 'email'}, user);
                return res.json(user);
            });
        } catch(err) {
            analytics.anonymousTrack('Registration Error', {
                error: err,
                email: req.body.email
            }, req.cookies.ajs_anonymous_id);
            logger.debug(`[register] registration error: ${err}`);
            return res.status(401).json(err);
        }
    },
    login: (req, res) => {
        logger.debug(`[login] req.user ${req.user.id}`);
        return User.findUserById(req.user.id).then(user => {          // to sanitize user before exposing
            analytics.identify(user, req);
            analytics.track('User Logged In', { userId: user.id }, user);
            return res.json(user);
        });
    },
    resetPassword: (req, res) => {
        const {resetPasswordToken, newPassword} = req.body;
        return User.resetPassword(resetPasswordToken, newPassword).then(dbUser => {
            req.login(dbUser, (err) => {
                if (err) {
                    throw err;
                }

                return User.findUserById(dbUser.id).then(user => {          // to sanitize user before exposing
                    analytics.identify(user, req);
                    return res.json(user);
                });
            });
        }).catch(err => {
            if (err.name === 'TokenExpired') {
                return res.status(500).json(err);
            }

            res.status(500).json(err);
        });
    },
    forgotPassword: (req, res) => {
        const {email} = req.body;
        UserService.forgotPassword(email).then(() => {
            res.json({message: `An email has been sent to ${email} with further instructions.`});
        }).catch(err => {
            return res.status(err.status || 500).json(err);
        });
    },
    updatePassword: (req, res) => {
        analytics.track('Update Password', {
            userId: req.user.id
        }, req.user);
        const {password, newPassword, newPasswordVerify} = req.body;
        if (newPassword !== newPasswordVerify) {
            return res.status(500).json(ResponseErrors.UpdatePasswordNewMismatch);
        }
        req.user.changePassword(password, newPassword, (err, user) => {
            if (!_.isEmpty(err)) {
                const errorResponse = _.get(ResponseErrors, `UpdatePassword${err.name}`);
                if (errorResponse) {
                    return res.status(500).json(errorResponse);
                } else {
                    logger.error('Error updating password', err);
                    return res.status(500).json(ResponseErrors.UpdatePasswordError);
                }
            }
            return res.json({status: 'ok'});
        });
    },
    validateEmail: (req, res, next) => {
        logger.debug('[validateEmail] validating email...');

        const token = _.get(req.query, 'validationToken');
        if (!token) {
            return res.status(400).send('missing validationToken parameter');
        }

        return EmailValidation.getValidationByToken(token).then(validation => {
            if (!validation) {
                logger.debug(`[validateEmail] token not found ${token}`);
                return res.status(404).send({status: 404, name: 'tokenNotFound', message: 'token not found'});
            }
            logger.debug(`[validateEmail] token found ${token}`);
            return User.addEmailAuthProvider(validation).then((user) => {
                if (req.user) {
                    req.logout();
                }
                req.login(user, (err) => {
                    if (err) { return next(err); }
                    logger.debug('[validateEmail] logging in...');
                    analytics.identify(user, req);
                    analytics.track('User Email Verified', {userId: user.id}, user);
                    return res.status(200).json({user, displayEmail: validation.email});
                });
            }).catch(err => {
                throw err;
            });
        }).catch(err => {
            res.status(500).json(err);
        });
    },
    logout: (req, res) => {
        req.logout();
        res.json({});
    },
    sanityToken: (req, res) => {
        const sanityConnection = req.user.connections.find(con => con.type === 'sanity');
        if (!sanityConnection) {
            logger.debug('Sanity: No connection to refresh');
            return res.status(404).send('Connection not found');
        }

        return SanityService.testToken(sanityConnection.accessToken).then(scope => {
            res.json(scope);
        }).catch(err => {
            return res.status(500).json(err);
        });

    },
    devtoGetUser: (req, res) => {
        const devtoConnection = req.user.connections.find(con => con.type === 'devto');
        if (!devtoConnection) {
            logger.debug('DevTo: No connection found');
            return res.status(404).send('Connection not found');
        }
        return DevToService.getUser(req.user).then(user => {
            if (!user) {
                throw ResponseErrors.NotFound;
            }
            return res.json(user);
        });
    },
    forestryRefresh: (req, res) => {
        return ForestryService.refreshToken(req.user)
            .then(() => {
                res.json({ status: 'ok' });
            })
            .catch(err => {
                res.status(err.code || 500).json(err);
            });
    }
};
