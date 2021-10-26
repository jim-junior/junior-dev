require('source-map-support').install();

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const cors = require('cors');
const MongoStore = require('connect-mongo')(session);
const morgan = require('morgan');
const aws = require('aws-sdk');
const Sentry = require('@sentry/node');

const baseConfig = require('./base-config');

if (baseConfig.env === 'local' && !process.env.AWS_ACCESS_KEY_ID) {
    aws.config.credentials = new aws.SharedIniFileCredentials();
} else {
    aws.config.update({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        signatureVersion: 'v4',
        region: 'us-east-1',
    });
}
// must come after AWS configuration
async function startServer({ provider = null, serverPort } = {}) {
    const configModule = require('./config');
    let config = null;
    try {
        config = await configModule.loadConfig();
    } catch (err) {
        console.error('Error loading config', { error: err });
        process.exit(67);
    }

    // modules that require fully loaded configuration
    Sentry.init({
        dsn: config.sentry.dsn,
        environment: config.env,
    });
    const logger = require('./services/logger');
    const { mongooseConnection } = require('./models/init-mongo');

    const orchestrator = require('./services/deploy-services/container-orchestration-service');
    orchestrator.initializeContainerEnvironments();

    const app = express();

    const passport = require('./services/auth-service/passport-init');

    let server = null;
    app.use(Sentry.Handlers.requestHandler({ user: ['id', 'email'] }));

    let origin = (Array.isArray(config.server.corsOrigin) ? config.server.corsOrigin : [config.server.corsOrigin]).map((item) =>
        item[0] === '/' ? new RegExp(item.slice(1, -1)) : item
    );
    logger.debug('Available CORS origins', origin);
    const corsDelegate = (req, cb) => {
        const reqOrigin = req.headers.origin || '';
        const matchOrigin = !!origin.some((o) => reqOrigin.match(o));
        let allowedBranchDeploy = false;
        let allowedRoute = false;
        if (!matchOrigin) {
            // Dynamic CORS
            allowedRoute = !!req.path.match(/^\/widget\//);
            allowedBranchDeploy = reqOrigin.indexOf(config.server.netlifyAppDomain) > -1;
        }
        cb(null, {
            credentials: true,
            origin: matchOrigin || allowedRoute || allowedBranchDeploy,
        });
    };
    app.use(cors(corsDelegate));
    app.use((req, res, next) => {
        if (
            !config.features.pullUseLambda ||
            !['/pull', '/segment'].find((s) => req.path.toLowerCase().startsWith(s)) ||
            req.query.direct
        ) {
            req.parseBody = true;
            return bodyParser.json({
                limit: '500kb',
                verify: (req, res, buffer, encoding) => {
                    // The Stripe webhook handler needs access to the raw request
                    // body, in order to validate the request signature.
                    //
                    // https://stripe.com/docs/webhooks/signatures
                    if (req.path.toLowerCase() === '/project/webhook/stripe') {
                        req.rawBody = buffer;
                    }
                },
            })(req, res, next);
        }
        next();
    });
    app.use((req, res, next) => (req.parseBody ? bodyParser.urlencoded({ extended: 'false' })(req, res, next) : next()));
    app.use(cookieParser());
    app.set('trust proxy', 1);
    app.use(
        session({
            secret: 'dormant-amoeba',
            resave: false,
            saveUninitialized: false,
            cookie: {
                maxAge: 365 * 24 * 60 * 60 * 1000,
                path: '/',
                sameSite: 'none',
                secure: true,
            },
            store: new MongoStore({ mongooseConnection: mongooseConnection }),
        })
    );

    app.use(passport.initialize());
    app.use(passport.session());
    provider && app.use(passport.authenticate(provider));

    // move to logging file
    morgan.token('userId', (req) => (req.user ? req.user.id : '-'));
    morgan.token('sessionId', (req) => (req.sessionID ? req.sessionID : '-'));
    app.use(
        morgan(config.logging.morganFormat, {
            stream: logger.writableStream,
            skip: (req, res) =>
                req.baseUrl === '/health' ||
                req.query.polling ||
                (req.baseUrl && (req.baseUrl.startsWith('/telemetry') || req.baseUrl.match(/^\/segment/) || req.baseUrl.match(/^\/pull/))),
        })
    );

    process.on('uncaughtException', function (err) {
        logger.error('Uncaught Server Exception', {
            error: err,
            stack: err.stack,
        });
        process.exit(1);
    });

    process.on('unhandledRejection', (error) => {
        logger.error('unhandledRejection', {
            error: error,
            stack: error.stack,
        });
    });

    // end logging file

    const router = require('./routers/index.router');
    app.use(router);

    const services = require('./services/services');

    try {
        await services.init();
        const port = serverPort || process.env.PORT || 8081;

        if (config.env === 'local') {
            await require('./server-local').configureLocalServer(app);
        } else {
            server = app.listen(port, () => {
                logger.debug('stackbit api is listening on port ' + port);
            });
        }

        return {
            app,
            server,
        };
    } catch (err) {
        console.log(err);
        logger.error('caught services error', { error: err });
        process.exit(65);
    }
}

module.exports = startServer;
