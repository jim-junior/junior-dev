const _ = require('lodash');
const Project = require('../models/project.model').default;

const containerSettingsKeys = [
    'imported', 'containerTrial', 'branch', 'publishBranch', 'previewBranch', 'env', 'netlify'
];

module.exports = {
    async up(db, client) {
        const objects = await Project.find({ $query: {'wizard.deployment.id': 'sharedContainer'}, $maxTimeMS: 60000 });
        return _.reduce(objects, async (previousPromise, object) => {
            await previousPromise;

            let containerUpdate = {
                'wizard.container.id': 'sharedContainer',
                'wizard.container.title': 'sharedContainer'
            };

            const deploymentUpdate = {
                'wizard.deployment.id': _.get(object, 'deploymentData.netlify') ? 'netlify' : null,
                'wizard.deployment.title': _.get(object, 'deploymentData.netlify') ? 'Netlify' : null
            };

            let $unset = {};

            _.forEach(_.get(object, 'wizard.deployment.settings', {}), (value, key) => {
                if (containerSettingsKeys.includes(key)) {
                    containerUpdate = {
                        ...containerUpdate,
                        [`wizard.container.settings.${key}`]: object.wizard.deployment.settings[key]
                    };

                    $unset = {
                        ...$unset,
                        [`wizard.deployment.settings.${key}`]: 1
                    };
                }
            });

            const update = {
                $set: {
                    ...deploymentUpdate,
                    ...containerUpdate
                }
            };

            if (!_.isEmpty($unset)) {
                update.$unset = $unset;
            }

            return Project.update(
                {
                    '_id' : object._id,
                },
                update
            );
        }, Promise.resolve());
    },

    async down(db, client) {
    // TODO write the statements to rollback your migration (if possible)
    // Example:
    // await db.collection('albums').updateOne({artist: 'The Beatles'}, {$set: {blacklisted: false}});
    }
};
