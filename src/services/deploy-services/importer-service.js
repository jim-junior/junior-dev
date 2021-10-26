const _ = require('lodash');
const os = require('os');
const fs = require('fs');
const fse = require('fs-extra');
const aws = require('aws-sdk');
const path = require('path');
const uuid = require('uuid/v4');
const rimraf = require('rimraf');

const config = require('../../config').default;
const Project = require('../../models/project.model').default;
const mediumImporter = require('@stackbit/stackbit-medium-importer');
const {sourceInputTheme} = require('./theme-services');
const DevToService = require('../../services/devto-services/devto-service');

module.exports = {
    doImport,
    cleanup
};

function getLocalFilePath(project) {
    if (project.importData.filePath) {
        return Promise.resolve(project.importData.filePath);
    } else if (project.importData.urlKey) {
        return new Promise((resolve, reject) => {
            var s3 = new aws.S3();
            var params = {
                Bucket: config.importer.medium.bucket,
                Key: project.importData.urlKey
            };
            const filePath = path.join(os.tmpdir(), `${uuid()}.zip`);
            const s3Stream = s3.getObject(params).createReadStream();
            const fileStream = fs.createWriteStream(filePath);
            s3Stream.on('error', reject);
            fileStream.on('error', reject);
            fileStream.on('close', () => {
                resolve(filePath);
            });
            s3Stream.pipe(fileStream);
        });
    }
    return Promise.reject('Import data missing');
}

function getDevToDataContext(user, logger) {
    const devtoConnection = user.connections.find(con => con.type === 'devto');
    if (!devtoConnection) {
        logger.debug('DevTo: No connection found');
        return Promise.resolve();
    }
    return DevToService.getUser(user).then(user => {
        let data = {
            author: {},
            social: {
                devto: {
                    username: user.username,
                    url: `https://dev.to/${user.username}`
                }
            },
            source: {
                title: 'Generated from DEV',
                url: 'https://dev.to/connecting-with-stackbit'
            }
        };
        if (user.name) {
            data.author.name = user.name;
        }
        if (user.twitter_username) {
            data.social.twitter = {
                username: user.twitter_username,
                url: `https://twitter.com/${user.twitter_username}`
            };
        }
        if (user.github_username) {
            data.social.github = {
                username: user.github_username,
                url: `https://github.com/${user.github_username}`
            };
        }
        if (user.profile_image) {
            data.author.avatar = user.profile_image;
        }
        if (user.summary) {
            data.author.tagline = user.summary;
        }
        return data;
    });
}

function clearSampleContent(baseDir) {
    const pattern = `${baseDir}/**/!(index|contact).md`;
    return new Promise((resolve, reject) => {
        rimraf(pattern, (err) => {
            if (err) {
                return reject(err);
            }
            resolve();
        });
    });
}

function doImport(project, user, buildLogger) {
    const importDataType = _.get(project, 'importData.dataType');
    if (importDataType === 'medium' &&
        (project.importData.filePath || project.importData.urlKey)) {

        return getLocalFilePath(project).then((filePath) => {
            return sourceInputTheme(project, null, buildLogger, {dirname: 'import'}).then(({repoPath}) => ({
                inputDir: repoPath,
                filePath
            }));
        }).then(({inputDir, filePath}) => {
            const postsDir = path.join(inputDir, 'content/posts');
            const imagesDir = path.join(inputDir, 'static/images');
            const originalDir = path.join(inputDir, 'orig');
            const dataFile = path.join(inputDir, '..', 'data.json');

            fse.emptyDirSync(postsDir);

            return mediumImporter.importer.doImport(filePath, postsDir, imagesDir, dataFile, originalDir).then(() => {
                buildLogger.debug('done import');
                return Project.setImportData(project.id, Object.assign(project.importData, {
                    importedPath: inputDir,
                    dataContextPath: dataFile
                }));
            }).finally(() => {
                fse.removeSync(filePath);
            });
        });
    } else if (importDataType === 'devto') {
        return sourceInputTheme(project, null, buildLogger, {dirname: 'import'}).then(({repoPath}) => {
            return clearSampleContent(repoPath).then(() => {
                return getDevToDataContext(user, buildLogger);
            }).then(dataContext => {
                const dataFile = path.join(repoPath, 'data.json');
                if (dataContext) {
                    fse.writeFileSync(dataFile, JSON.stringify(dataContext));
                    return dataFile;
                }
            }).then(dataFile => {
                return Project.setImportData(project.id, Object.assign(project.importData, {
                    importedPath: repoPath,
                    dataContextPath: dataFile
                }));
            });
        });
    }
    return Promise.resolve(project);
}

function cleanup(project) {
    const tmpInputDir = _.get(project, 'importData.importedPath');
    if (tmpInputDir) {
        fse.removeSync(tmpInputDir);
    }
}

