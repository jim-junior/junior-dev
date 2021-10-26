import Project from '../models/project.model';

/*
  In April 2021 we introduced the first version of the Schema Editor in the Studio.
  Since projects created with Stackbit-authored themes before April 3rd, 2021 were generated
  with invalid schemas, that would confuse innocent users and give a bad experience, we decided
  to disable the Schema Editor for all of those users.

  Even though Schema Editor, at least at this time, is only available for Git CMS, we included all
  CMSs in this migration.
 */

const $query = {
    buildStatus: {
        $not: { $eq: 'draft' },
    },
    'wizard.theme.id': { $not: { $eq: 'custom' } },
    createdAt: { $lt: new Date('2021-04-03T00:00:00.000+00:00') },
};

module.exports = {
    async up() {
        try {
            const cursor = Project.find({ $query }).cursor();
            let writes = [];
            for (let project = await cursor.next(); project != null; project = await cursor.next()) {
                writes.push({
                    updateOne: {
                        filter: { _id: project.id },
                        update: {
                            $set: {
                                'widget.schemaEditorEnabled': false
                            }
                        },
                        timestamps: false
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
