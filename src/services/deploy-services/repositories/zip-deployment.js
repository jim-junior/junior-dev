const fs = require('fs');
const archiver = require('archiver');
const path = require('path');
const ZIP_PATH = path.join(__dirname, '../../../../data/public/zip');
const config = require('../../../config').default;
const Project = require('../../../models/project.model').default;
const _ = require('lodash');

module.exports = {
    deploy: function (project, user, buildLogger) {
        let zipFileName = `${project.name}.zip`;
        return new Promise((resolve, reject)=>{
            let zipFullPath = path.join(ZIP_PATH, zipFileName);
            buildLogger.debug('Zipping project');
            const output = fs.createWriteStream(zipFullPath);
            const archive = archiver('zip', {
                zlib: { level: 9 }
            });

            output.on('close', function() {
                buildLogger.debug('Zipping complete');
                resolve(zipFullPath);
            });

            output.on('end', function() {
                buildLogger.debug('Zipping complete');
                resolve(zipFullPath);
            });

            archive.on('warning', function(err) {
                buildLogger.debug('zip warn', {error: err});
                reject(err);
            });

            archive.on('error', function(err) {
                buildLogger.debug('zip err', {error: err});
                reject(err);
            });

            archive.pipe(output);
            archive.directory(_.get(project, 'deploymentData.build.outputDir'), false);
            archive.finalize();
        }).then((zipPath)=>{
            let downloadUrl = config.server.hostname + '/zip/' + zipFileName;
            return Project.updateDeploymentData(project._id, 'zip', {
                outputPath: zipPath,
                downloadUrl: downloadUrl,
                url: downloadUrl
            });
        });
    }
};
