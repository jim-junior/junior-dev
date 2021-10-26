import _ from 'lodash';
import Project from '../models/project.model';

const $QUERY = { $or:
        [
            {'wizard.ssg.settings.refreshCommand': { $exists: true }},
            {'wizard.ssg.settings.runnableDir': { $exists: true }},
        ]
};

module.exports = {
    async up() {
        try {
            const cursor = Project.find({ $query: $QUERY }).cursor();
            let writes = [];
            for (let project = await cursor.next(); project != null; project = await cursor.next()) {
                const $set: any = {};
                const $unset: any = {};
                const { refreshCommand, runnableDir } = project.wizard?.ssg?.settings || {};

                if (!_.isNil(refreshCommand)) {
                    $set['deploymentData.container.refreshCommand'] = refreshCommand;
                    $unset['wizard.ssg.settings.refreshCommand'] = 1;
                }

                if (!_.isNil(runnableDir)) {
                    $set['deploymentData.container.runnableDir'] = runnableDir;
                    $unset['wizard.ssg.settings.runnableDir'] = 1;
                }

                writes.push({
                    updateOne: {
                        filter: { _id: project.id },
                        update: {
                            $set,
                            $unset
                        },
                        timestamps: false,
                        strict: false,
                        multi: true,
                        upsert: true
                    }
                });

                if (writes.length >= 1000) {
                    await Project.bulkWrite(writes, { ordered: false });
                    writes = [];
                }
            }

            if (writes.length > 0) {
                await Project.bulkWrite(writes, { ordered: false });
            }
        } catch (e: any) {
            console.error(e.stack);
            throw e;
        }
    },

    async down() {},
};
