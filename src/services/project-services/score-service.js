const logger = require('../logger');

const Project = require('../../models/project.model').default;

const ACTION_TYPES = {
    transferRepo: 3,
    createPage: 2,
    duplicatePage: 2,
    updatePage: 1,
    assetUploadStart: 2,
    getAssets: 0,
    'publishContent-all': 3,
    'publishContent-objects': 6,
    scheduledPublish: 6,
    collaboratorInvite: 6
};

function addScoreForAction(action, projectId) {
    const score = ACTION_TYPES[action];
    if (score >= 0) {
        logger.debug('ProjectScoreService: adding score to project for action', {action, score, projectId});
        return Project.incrementProjectStudioScore(projectId, score);
    } else {
        logger.debug('ProjectScoreService: Cannot add score, missing action type', {action, projectId});
    }
}

module.exports = {
    addScoreForAction
};
