const winston = require('winston');
const Logger = require('r7insight_node');
const SentryTransport = require('winston-sentry-log');
const _ = require('lodash');

const config = require('../config').default;

const formatError = winston.format((info, options) => {
    _.forEach(info, (value, key) => {
        if (value instanceof Error) {
            info[key] = value.stack || value.toString();
        }
    });
    return info;
});

const logger = winston.createLogger({
    level: config.logging.level,
    format: winston.format.combine(
        formatError()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        }),
        new winston.transports.Logentries({
            token: config.logging.logentries.token,
            region: 'us',
            json: true,
            timestamp: true,
            levels: {
                error: 4,
                warn: 3
            }
        }),
        new SentryTransport({
            config: {
                dsn: config.sentry.dsn,
                environment: config.env
            },
            level: 'error'
        })
    ]
});

logger.writableStream = {
    write: function (message, encoding) {
        logger.info(message.trim());
    }
};

module.exports = logger;
