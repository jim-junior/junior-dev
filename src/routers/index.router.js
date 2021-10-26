const express = require('express');
const appRouter = express.Router();
const Sentry = require('@sentry/node');
const _ = require('lodash');

const azureConfig = require('../config').default.azure;
const authRouter = require('./auth.router');
const userRouter = require('./user.router');
const orgRouter = require('./organization.router');
const projectRouter = require('./project.router');
const studioRouter = require('./studio.router');
const githubRouter = require('./github.router');
const adminRouter = require('./admin.router');
const ratingRouter = require('./rating.router');
const segmentRouter = require('./segment.router');
const telemetryRouter = require('./telemetry.router');
const pullRouter = require('./pull.router');
const widgetRouter = require('./widget.router');
const joboxRouter = require('./jobox.router');
const previewRouter = require('./preview.router');
const emailValidationRouter = require('./email-validation.router');
const sanityRouter = require('./sanity.router');
const netlifyRouter = require('./netlify.router');
const webhookRouter = require('./webhook.router');
const mailRouter = require('./mail.router');

const logger = require('../services/logger');
const responseErrors = require('./response-errors');

appRouter.use((req,res, next) => {
    const transactionId = req.header('X-Transaction-ID');

    if (transactionId) {
        Sentry.configureScope((scope) => {
            scope.setTag('transaction_id', transactionId);
        });
    }

    next();
});

appRouter.use('/auth', authRouter);
appRouter.use('/user', userRouter);
appRouter.use('/organization', orgRouter);
appRouter.use('/project', projectRouter);
appRouter.use('/studio', studioRouter);
appRouter.use('/github', githubRouter);
appRouter.use('/rating', ratingRouter);
appRouter.use('/segment', segmentRouter);
appRouter.use('/telemetry', telemetryRouter);
appRouter.use('/admin', adminRouter);
appRouter.use('/pull', pullRouter);
appRouter.use('/widget', widgetRouter);
appRouter.use('/jobox', joboxRouter);
appRouter.use('/preview', previewRouter);
appRouter.use('/emailvalidation', emailValidationRouter);
appRouter.use('/sanity', sanityRouter);
appRouter.use('/netlify', netlifyRouter);
appRouter.use('/webhook', webhookRouter);
appRouter.use('/mail', mailRouter);
appRouter.use('/health', (req, res) => res.status(200).json({health: 'ok'}));

appRouter.use(express.static('data/public'));

// Microsoft needs proper length of content and fails if we simply response with res.json()
// https://github.com/MicrosoftDocs/azure-docs/issues/39665#issuecomment-538104258
appRouter.use('/.well-known/microsoft-identity-association.json', (req, res) => {
    const data = JSON.stringify({
        associatedApplications: [
            {
                applicationId: azureConfig.applicationId
            }
        ]
    });
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data, 'utf-8')
    });

    res.write(data);
    res.end();
});

appRouter.use(Sentry.Handlers.errorHandler());
appRouter.use(function (err, req, res, next) {
    if (res.headersSent) {
        logger.error('Error middleware: Error after response sent', {
            error: err,
            stack: err.stack,
            debugError: err.debugError,
            userId: _.get(req, 'user.id'),
            sentryErrorId: res.sentry
        });
        return next(err);
    }

    if (err.name && responseErrors[err.name]) {
        logger.error('Error middleware: Whitelisted error', {
            error: err,
            stack: err.stack,
            debugError: err.debugError,
            userId: _.get(req, 'user.id'),
            sentryErrorId: res.sentry
        });
        if (err.debugError) {
            delete err.debugError;
        }
        res.status(err.status).json(err);
    } else {
        logger.error('Error middleware: non whitelisted error', {
            error: err,
            stack: err.stack,
            userId: _.get(req, 'user.id'),
            sentryErrorId: res.sentry
        });
        res.status(err.status || 500).send(
            `We've encountered an unexpected problem. Our team has been notified and we'll look into it shortly.\nError reference: ${res.sentry}`
        );
    }
});

module.exports = appRouter;
