const _ = require('lodash');
const uuid = require('uuid/v4');
const config = require('../../config').default;
const Project = require('../../models/project.model').default;

function getAuthClient(user) {
    const googleConnection = _.get(user, 'connections', []).find(c => c.type === 'google');
    if (!googleConnection) {
        throw new Error(`Provided user ${user.id} has no google connection to get client for`);
    }
    const {google} = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(config.google.appClientId, config.google.appClientSecret);
    oauth2Client.setCredentials({
        access_token: googleConnection.accessToken,
        refresh_token: googleConnection.refreshToken
    });

    oauth2Client.once('tokens', (tokens) => {
        return user.addConnection('google', {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token
        });
    });

    return oauth2Client;
}

function getDriveClient(user) {
    const {google} = require('googleapis');
    return google.drive({
        version: 'v3',
        auth: getAuthClient(user)
    });
}

function watchFile(fileId, project, user) {
    const docsData = _.get(project, 'deploymentData.container.googledocs', {});
    const expiration = docsData.watchExpiration;
    if (expiration && Date.now() < expiration) {
        return Promise.resolve({
            new: false,
            ...docsData
        }); // user already have active watcher
    }
    const webhookHostname = config.server.webhookHostname;
    const client = getDriveClient(user);
    return client.files.watch({
        fileId,
        requestBody: {
            type: 'web_hook',
            address: `${webhookHostname}/project/${project.id}/webhook/google`,
            expiration: Date.now() + 86400000, // max for google is 1 day
            id: uuid()
        }
    }).then(res => ({
        new: true,
        id: res.data.id,
        resourceId: res.data.resourceId,
        expiration: parseInt(res.data.expiration, 10)
    })).then(watchResponse => {
        const update = {
            'googledocs.watchId': watchResponse.id,
            'googledocs.watchResourceId': watchResponse.resourceId,
            'googledocs.watchExpiration': watchResponse.expiration
        };
        return Project.updateDeploymentData(project.id, 'container', update).then(() => watchResponse);
    });
}

function stopWatchFile(project, user) {
    const docsData = _.get(project, 'deploymentData.container.googledocs', {});
    const expiration = docsData.watchExpiration;
    if (!expiration || Date.now() >= expiration) {
        return Promise.resolve(project);
    }
    return getDriveClient(user).channels.stop({
        requestBody: {
            id: docsData.watchId,
            resourceId: docsData.watchResourceId
        }
    }).then(res => {
        const update = {
            'googledocs.watchId': '',
            'googledocs.watchResourceId': '',
            'googledocs.watchExpiration': ''
        };
        return Project.updateDeploymentData(project._id, 'container', update);
    });
}

function validateWatcher(project, user) {
    const docsData = _.get(project, 'deploymentData.container.googledocs', {});
    const docId = docsData.docId;
    const expiration = docsData.watchExpiration;
    if (docId && (!expiration || ((expiration - Date.now()) < 3600000))) {
        return stopWatchFile(project, user)
            .then((project) => watchFile(docId, project, user));
    }
    return Promise.resolve(docsData);
}

function getFileVersion(fileId, user) {
    return getDriveClient(user).files.get({ fileId, fields: 'version' })
        .then(res => res.data.version);
}

function getFileLatestRevision(fileId, user) {
    const client = getDriveClient(user);

    const getRevisions = (pageToken) => {
        return client.revisions.list({
            fileId,
            pageToken,
            fields: 'nextPageToken,revisions(id)',
            pageSize: 1000,
        }).then((res) => {
            if (res.data.nextPageToken) {
                return getRevisions(res.data.nextPageToken);
            }
            return _.last(res.data.revisions).id;
        });
    };

    return getRevisions()
        .catch((err) => {
            if (err && err.code === 403) {
                return getFileVersion(fileId, user); // revisions isn't available for shared docs, while version is
            }
            throw err;
        });
}

module.exports = {
    getAuthClient,
    watchFile,
    stopWatchFile,
    validateWatcher,
    getFileVersion,
    getFileLatestRevision
};