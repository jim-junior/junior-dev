const Project = require('../models/project.model').default;

module.exports = {
    async up(db, client) {
        // this migration ensures that the removed computed property `isStackbitPull`
        // from prebuilt-theme-service.js will be set on all projects as true
        await Project.updateMany({
            $or: [
                {'settings.isGenericContainer': {$eq: false}},
                {'settings.isGenericContainer': {$exists: false}}
            ],
            'wizard.theme.id': {$ne: 'custom', $exists: true},
            'wizard.ssg.id': 'gatsby',
            'settings.hasStackbitPull': {$exists: false}
        }, {
            $set: {'settings.hasStackbitPull': true}
        });
    },

    async down(db, client) {
        // can't really rollback this migration because for same condition
        // settings.hasStackbitPull could be already set to true
    }
};
