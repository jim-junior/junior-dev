import mongoose from 'mongoose';
const analytics = require('../../services/analytics/analytics');
const Project = require('../../models/project.model').default;
const User = require('../../models/user.model').default;
const logger = require('../../services/logger');
const ResponseErrors = require('../response-errors');
const stripeService = require('../../services/stripe-service/stripe-service');
const { isValidPreferences } = require('../../services/user-services/user-service');

module.exports = {
    user: (req, res) => {
        return User.findUserById(req.user.id)
            .then((dbUser) => {
                return Project.projectTiersForUser(dbUser._id).then((tiers) => {
                    dbUser.projectTiers = tiers;
                    res.json(dbUser);
                });
            })
            .catch((err) => {
                logger.debug('User: Error Getting User', { err: err?.message });
                return res.status(404).json(err);
            });
    },
    isAuthenticated: (req, res) => {
        return User.findUserById(req.user?.id)
            .then((user) => {
                return res.json({ isAuthenticated: Boolean(user) });
            })
            .catch((err) => {
                logger.debug('User: Error Getting Authenticated User Status', { err: err?.message });
                return res.status(500).json(err);
            });
    },
    deleteUser: (req, res) => {
        analytics.track(
            'Delete User',
            {
                userId: req.user.id
            },
            req.user
        );

        const { password } = req.body;
        let promise;

        if (req.user.authProvider === 'email') {
            promise = new Promise((resolve, reject) => {
                req.user.authenticate(password, (err, user) => {
                    if (err) {
                        logger.error('Error authenticating for user delete', err);
                        reject(err);
                    }
                    if (!user) {
                        reject(ResponseErrors.DeleteUserIncorrectPasswordError);
                    }
                    resolve();
                });
            });
        } else {
            if (password === req.user.displayName) {
                promise = Promise.resolve();
            } else {
                promise = Promise.reject(ResponseErrors.DeleteUserIncorrectDisplayName);
            }
        }

        promise
            .then(async () => {
                const projects = await Project.findOwnProjectsForUser(req.user.id);
                const promises = projects.map(async (project) => {
                    if (project.hasSubscription()) {
                        await stripeService.cancelSubscription({ project });
                    }
                });
                return Promise.all(promises);
            })
            .then(() =>
                req.user.deleteUserAndContent().catch((err) => {
                    logger.error('Error deleting projects for user delete', err);
                    throw ResponseErrors.DeleteUserError;
                })
            )
            .then(() => res.json({ status: 'ok' }))
            .catch((err) => {
                logger.error('Error deleting projects for user delete', err);
                res.status(err.status || 500).json(err);
            });
    },
    updateUserPreferences: async (req, res) => {
        try {
            const { preferences } = req.body;
            let user = req.user;

            if (!preferences) {
                return res.status(500).json(ResponseErrors.UpdatePreferencesEmpty);
            }

            const isValid = await isValidPreferences(user, preferences);
            if (isValid) {
                user = await user.updatePreferences(preferences);
            }

            return res.json(user);
        } catch (err) {
            logger.debug('User: Error Updating User Preferences', { err: err?.message });
            return res.status(500).json(err);
        }
    },
    addSurvey: (req, res) => {
        const survey = req.body;
        const user = req.user;
        let { overwrite } = req.query;
        if (overwrite === 'true') {
            overwrite = true;
        }
        if (!survey.name) {
            return res.status(500).json(ResponseErrors.SurveyNameRequired);
        }
        return User.addSurvey(user.id, survey, overwrite)
            .then((newSurvey) => {
                analytics.track(
                    'Survey Completed',
                    {
                        userId: user.id,
                        surveyName: survey.name,
                        surveyFields: survey.fields,
                        surveyCreatedAt: survey.createdAt
                    },
                    user
                );
                return res.status(200).json(newSurvey);
            })
            .catch((err) => {
                logger.debug('User: Error Adding User Survey', { err: err?.message });
                return res.status(err.status || 500).json(err);
            });
    },
    addProjectToFavorites: async (req, res) => {
        try {
            const { projectId: id } = req.params;
            const userId = req?.user?._id;

            if (!userId) {
                logger.error('[addProjectToFavorites] no userId provided', { id });
                throw ResponseErrors.UnsupportedOperation;
            }

            if (!id) {
                logger.error('[addProjectToFavorites] no id provided', { userId });
                throw ResponseErrors.UnsupportedOperation;
            }
            const projectObjectId = mongoose.Types.ObjectId(id);
            const userObjectId = mongoose.Types.ObjectId(userId);
            await User.addProjectToFavorites(projectObjectId, userObjectId);
            res.status(200).json();
        } catch (err) {
            logger.error('User: [addProjectToFavorites] Error Add Project To Favorites', { err: err?.message });
            res.status(err.status || 500).json(err);
        }
    },
    removeProjectFromFavorites: async (req, res) => {
        try {
            const { projectId: id } = req.params;
            const userId = req?.user?._id;

            if (!userId) {
                logger.error('[removeProjectFromFavorites] no projectGroupId provided', { id });
                throw ResponseErrors.UnsupportedOperation;
            }

            if (!id) {
                logger.error('[removeProjectFromFavorites] no id provided', { userId });
                throw ResponseErrors.UnsupportedOperation;
            }
            const projectObjectId = mongoose.Types.ObjectId(id);
            const userObjectId = mongoose.Types.ObjectId(userId);
            await User.removeProjectFromFavorites(projectObjectId, userObjectId);
            res.status(200).json();
        } catch (err) {
            logger.error('User: [removeProjectFromFavorites] Error Remove Project From Favorites', { err: err?.message });
            res.status(err.status || 500).json(err);
        }
    }
};
