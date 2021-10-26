const logger = require('./logger');
const initMongo = require('../models/init-mongo');

module.exports = {
    init
};

function init() {
    logger.info('Initializing Server...');
    logger.info('Connecting to MongoDB...');
    return initMongo.init();
}
