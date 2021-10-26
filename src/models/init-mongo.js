const mongoose = require('mongoose');
const mongoUrl = require('../config').default.mongo.url;
const logger = require('../services/logger');
const migrateMongoConfig = require('../migrate-mongo-config');
const migrateMongo = require('migrate-mongo');
const Lock = require('./lock.model').default;

function init(isServerless = false) {
    return new Promise((resolve,reject)=>{
        mongoose.Promise = global.Promise;

        mongoose.connection.on('error', err => {
            logger.error('MongoDB connection error', {error: err});
            reject(err);
        });
        mongoose.connection.on('connected', () => {
            logger.info('Mongo Connection Successful!');
            resolve(mongoose.connection);
        });

        let options = {
            useNewUrlParser: true
        };
        if (isServerless) {
            options.bufferCommands = false; // Disable mongoose buffering
            options.bufferMaxEntries = 0; // and MongoDB driver buffering
        }
        mongoose.connect(mongoUrl, options).then(() => {
            process.on('SIGINT', closeConnection);
            process.on('SIGTERM', closeConnection);
        }).then(() => {
            return migrate();
        }).catch(err => {
            reject(err);
        });
    });
}

function closeConnection() {
    mongoose.connection.close(function () {
        console.log('Closed Mongo connection due to application termination');
        process.exit(0);
    });
}

async function migrate() {
    const lockName = 'mongo-migrate';
    logger.info('run mongo migrations');
    const lockAcquired = await Lock.acquire(lockName);
    if (!lockAcquired) {
        logger.info(`could not acquire ${lockName} lock, skipping`);
        return;
    }
    migrateMongo.config.set(migrateMongoConfig);
    return migrateMongo.database.connect()
        .then(({db, client}) => {
            return migrateMongo.up(db, client).then(migrated => {
                logger.info('finished running mongo migrations');
                printMigrated(migrated);
            }).catch(err => {
                logger.error(`error running mongo migrating: ${err.message}`);
                printMigrated(err.migrated);
            }).finally(() => {
                client.close();
            });
        }).catch(err => {
            logger.error(`Error connecting to mongo for migrations: ${err.message}`);
        }).finally(() => {
            return Lock.release(lockName);
        });
}

function printMigrated(migrated = []) {
    migrated.forEach(migratedItem => {
        logger.info(`migrated up: ${migratedItem}`);
    });
}

module.exports = {
    init,
    mongooseConnection: mongoose.connection
};
