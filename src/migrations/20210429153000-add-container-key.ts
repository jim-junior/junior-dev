import crypto from 'crypto';
import Project from '../models/project.model';

/*
  New container flow was introduced where env vars are loaded from the API instead of hardcoding
  them on createTask aws step. It's available at /project/:id/config and uses key (container-key)
  so only api && container knows about them and API can understand that this is container speaking.
  Some of containers dont have that key by various reasons - so this migration adds them
*/

const $query = {
    buildStatus: {
        $not: { $eq: 'draft' },
    },
    'deploymentData.container': { $exists: true },
    APIKeys: {
        $not: {
            $elemMatch: {
                name: 'container-key'
            }
        }
    }
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
                            $push: {
                                APIKeys: {
                                    name: 'container-key',
                                    key: crypto.randomBytes(32).toString('hex')
                                }
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
