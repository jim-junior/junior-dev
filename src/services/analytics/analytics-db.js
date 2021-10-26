const _ = require('lodash');
const pg = require('pg');
const postgresUrl = require('../../config').default.analyticsDb.url;

function connect() {
    if (!postgresUrl) {
        return null; // Not all environments have this available.
    }
    process.on('SIGINT', closeConnection);
    process.on('SIGTERM', closeConnection);
    return new pg.Pool({
        connectionString: postgresUrl
    });
}

const pool = connect();

function closeConnection() {
    if (pool) {
        pool.end();
    }
}

module.exports = {
    pool,
};
