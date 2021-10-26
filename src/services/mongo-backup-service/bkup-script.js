require('../../config').loadConfig().catch(err => {
    console.error('Error loading config', {error: err});
    process.exit(67);
}).then((config) => {

    const mongoUrl = config.mongo.url;
    const {BackupAndUpload} = require('./mongo-backup');
    const backupConfig = {
        mongodb: {
            'database': 'stackbit-api',
            'uri': mongoUrl
        },
        s3: {
            accessKey: '',  //AccessKey
            secretKey: '',  //SecretKey
            accessPerm: 'private', //S3 Bucket Privacy, Since, You'll be storing Database, Private is HIGHLY Recommended
            bucketName: 'stackbit-mongodb-dump-dev', //Bucket Name,
            keyPrefix: 'local'
        },
        keepLocalBackups: true,  //If true, It'll create a folder in project root with database's name and store backups in it and if it's false, It'll use temporary directory of OS
        noOfLocalBackups: 5  //This will only keep the most recent 5 backups and delete all older backups from local backup directory
    };

    BackupAndUpload(backupConfig).then(onResolve => {
        console.log(onResolve);
    }).catch(onReject => {
        console.log(onReject);
    });

});