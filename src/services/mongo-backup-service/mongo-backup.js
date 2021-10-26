// based on: https://github.com/ishanjain28/s3-mongo-backup
'use strict';

const path = require('path'),
    fs = require('fs'),
    exec = require('child_process').exec,
    AWS = require('aws-sdk'),
    logger = require('../logger');

let BACKUP_PATH = (ZIP_NAME) => path.resolve(__dirname, ZIP_NAME);

function BackupMongoDatabase(config) {
    return new Promise((resolve, reject) => {
        const database = config.mongodb.database,
            host = config.mongodb.host || null,
            port = config.mongodb.port || null,
            uri =  config.mongodb.uri || null;

        let DB_BACKUP_NAME = `${config.s3.keyPrefix}_${database}_${new Date().toISOString()}.gz`;

        // Default command, does not considers username or password
        let command = uri ?  `mongodump --uri="${uri}" --gzip --archive=${BACKUP_PATH(DB_BACKUP_NAME)}`
            : `mongodump -h ${host} --port=${port} -d ${database} --gzip --archive=${BACKUP_PATH(DB_BACKUP_NAME)}`;

        exec(command, (err, stdout, stderr) => {
            if (err) {
                // Most likely, mongodump isn't installed or isn't accessible
                reject({
                    error: 1,
                    message: err.message
                });
            } else {
                resolve({
                    error: 0,
                    message: 'Successfuly Created Backup',
                    backupName: DB_BACKUP_NAME
                });
            }
        });
    });
}

function DeleteLocalBackup(ZIP_NAME) {
    return new Promise((resolve, reject) => {
        fs.unlink(BACKUP_PATH(ZIP_NAME), (err) => {
            if (err) {
                reject(err);
            } else {
                resolve({
                    error: 0,
                    message: 'Deleted Local backup',
                    zipName: ZIP_NAME
                });
            }
        });
    });
}

function UploadFileToS3(S3, ZIP_NAME, config) {
    return new Promise((resolve, reject) => {
        let fileStream = fs.createReadStream(BACKUP_PATH(ZIP_NAME));

        fileStream.on('error', err => {
            return reject({
                error: 1,
                message: err.message
            });
        });

        let uploadParams = {
            Bucket: config.s3.bucketName,
            Key: `${config.s3.keyPrefix}/${ZIP_NAME}`,
            Body: fileStream
        };

        S3.upload(uploadParams, (err, data) => {
            if (err) {
                return reject({
                    error: 1,
                    message: err.message,
                    code: err.code
                });
            }

            if (!config.keepLocalBackups) {
                //  Not supposed to keep local backups, so delete the one that was just uploaded
                DeleteLocalBackup(ZIP_NAME).then(deleteLocalBackupResult => {
                    resolve({
                        error: 0,
                        message: 'Upload Successful, Deleted Local Copy of Backup',
                        data: data
                    });
                }, deleteLocalBackupError => {
                    resolve({
                        error: 1,
                        message: deleteLocalBackupError,
                        data: data
                    });
                });
            } else {
                resolve({
                    error: 0,
                    message: 'Upload Successful',
                    data: data
                });
            }
        });
    });
}

function UploadBackup(config, backupResult) {
    let s3 = new AWS.S3();

    return UploadFileToS3(s3, backupResult.zipName, config).then(uploadFileResult => {
        return Promise.resolve(uploadFileResult);
    }, uploadFileError => {
        return Promise.reject(uploadFileError);
    });
}

function CreateBackup(config) {
    // Backup Mongo Database
    return BackupMongoDatabase(config).then(result => {
        return Promise.resolve({
            error: 0,
            message: 'Successfully Created Compressed Archive of Database',
            zipName: result.backupName
        });
    }, error => {
        return Promise.reject(error);
    });
}

function BackupAndUpload(config) {
    // Check if the configuration is valid
    logger.debug('DB Backup Started');
    return CreateBackup(config).then(backupResult => {
        logger.debug('DB Backup mongodump created');
        // Upload it to S3
        return UploadBackup(config, backupResult).then(res => {
            logger.debug('DB Backup uploaded');
            return Promise.resolve(res);
        }, err => {
            return Promise.reject(err);
        });
    }, backupResult => {
        return Promise.reject(backupResult);
    });
}

function getBackups(options) {
    const s3 = new AWS.S3();
    const listParams = {
        Bucket: options.bucketName,
        Prefix: options.keyPrefix,
    };

    return s3.listObjects(listParams)
        .promise();
}

function BackupAndUploadWithConfig(config) {
    return BackupAndUpload({
        mongodb: {
            'database': 'stackbit-api',
            'host': config.mongo.host,
            'port': 27017
        },
        s3: {
            accessKey: '', // AccessKey
            secretKey: '', // SecretKey
            accessPerm: 'private', // S3 Bucket Privacy, Since, You'll be storing Database, Private is HIGHLY Recommended
            bucketName: 'stackbit-mongodb-dump-dev', //Bucket Name,
            keyPrefix: config.env
        },
        keepLocalBackups: false, // If true, It'll create a folder in project root with database's name and store backups in it and if it's false, It'll use temporary directory of OS
        noOfLocalBackups: 5 // This will only keep the most recent 5 backups and delete all older backups from local backup directory
    });
}

module.exports = {
    BackupAndUpload,
    BackupAndUploadWithConfig,
    getBackups
};
