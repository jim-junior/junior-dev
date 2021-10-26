const express = require('express');
const axios = require('axios');
const _ = require('lodash');
const logger = require('../services/logger');
const config = require('../config').default;
const router = express.Router();

/**
 * The Telemetry Router is used by Stackbit-CLI
 */

const segmentAuthorization = 'Basic ' + Buffer.from(config.customer.cliTelemetryApiKey + ':').toString('base64');

router.post('/cli', (req, res) => {
    res.status(200).end();
    const headers = _.assign(
        _.omit(req.headers, ['host', 'authorization']),
        { authorization: segmentAuthorization }
    );
    const batch = _.get(req.body, 'batch');
    const cliErrorEvent = 'cli_uncaught_exception';
    _.forEach(batch, (event) => {
        if (event.event === cliErrorEvent) {
            logger.error('CLI Error', _.omit(event, 'event'));
        } else {
            logger.debug(event.event, _.omit(event, 'event'));
        }
    });

    // don't send errors to analytics
    _.set(req.body, 'batch', _.reject(batch, { event: cliErrorEvent }));
    if (_.isEmpty(req.body.batch)) {
        return;
    }

    axios({
        method: 'post',
        url: 'https://api.segment.io/v1/batch',
        headers: headers,
        data: req.body
    })
        .then(function(response) {

        })
        .catch(function(error) {
            logger.error('error in /telemetry/cli, segment.io responded with error', error);
        });
});

module.exports = router;
