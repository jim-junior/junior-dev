const proxy = require('../services/proxy');
const express = require('express');
const router = express.Router();
const config = require('../config').default;

const pullRoutes = require('./routes/pull.routes');
const logger = require('../services/logger');

if (config.features.pullUseLambda) {
    logger.info('Using Lambda for pulling projects');
    router.use(proxy((path, req) => {
        return !req.query.direct;
    }, {
        target: config.build.buildApiBaseUrl,
        changeOrigin: true,
        logProvider: () => logger,
    }));
} else {
    logger.info('Using API for pulling projects');
}

router.post('/:projectId', pullRoutes.pullProject);

module.exports = router;
