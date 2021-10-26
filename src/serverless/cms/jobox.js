const {createDataFiles} = require('./cms-common-utils');
const aws = require('aws-sdk');
const logger = require('../../services/logger');
const JoboxService = require('../../services/jobox-service/jobox-service');

function fetchJoboxData(project, options) {
    return new Promise((resolve, reject) => {
        const s3 = new aws.S3();
        s3.getObject({
            Bucket: JoboxService.DATA_BUCKET_NAME,
            Key: `${project.id}/data.json`
        }, (err, data) => {
            if (err) {
                return reject(err);
            }
            resolve(data.Body.toString());
        });
    }).then(data => {
        try {
            data = JSON.parse(data);
        } catch (err) {
            logger.error('Jobox: failed to json parse content');
        }
        return createDataFiles([{
            stackbit_file_path: '/data.json',
            ...data
        }], null, options);
    });
}

module.exports = {
    fetchJoboxData
};
