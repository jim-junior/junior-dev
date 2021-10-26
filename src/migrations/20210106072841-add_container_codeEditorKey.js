const _ = require('lodash');
const Project = require('../models/project.model').default;
const codeUtils = require('../services/utils/code.utils');

// Sett `codeEditorKey` for container projects that don't have it

const $QUERY = {'deploymentData.container': { '$exists' : true }, 'deploymentData.container.codeEditorKey': { '$exists' : false }};

module.exports = {
    async up(db, client) {
        const cursor = Project.find({ $query: $QUERY }).cursor();
        for (let project = await cursor.next(); project != null; project = await cursor.next()) {
            await Project.update(
                { '_id' : project._id },
                { 'deploymentData.container.codeEditorKey': codeUtils.getRandomSecureString()}
            );
        }
    },

    async down(db, client) {
    }
};
