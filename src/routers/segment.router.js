const express = require('express');
const router = express.Router();
const proxy = require('../services/proxy');
const logger = require('../services/logger');

router.use(proxy({
    target: 'https://api.segment.io/',
    pathRewrite: {
        '^/segment': ''
    },
    headers: {
        'Connection': 'keep-alive'
    },
    secure: false,
    logProvider: () => logger
}));

module.exports = router;
