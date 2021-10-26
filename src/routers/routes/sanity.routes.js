const SanityService = require('../../services/sanity-services/sanity-service');
const logger = require('../../services/logger');

module.exports = {
    getUser: (req, res) => {
        const sanityConnection = req.user.connections.find(con => con.type === 'sanity');
        if (!sanityConnection) {
            logger.debug('Sanity: No connection found');
            return res.status(404).send('Connection not found');
        }

        return SanityService.getUser(sanityConnection.accessToken).then(user => {
            res.json(user);
        }).catch(err => {
            return res.status(500).json(err);
        });

    },
    getProjects: (req, res) => {
        const sanityConnection = req.user.connections.find(con => con.type === 'sanity');
        if (!sanityConnection) {
            logger.debug('Sanity: No connection found');
            return res.status(404).send('Connection not found');
        }

        return SanityService.getProjects(sanityConnection.accessToken).then(projects => {
            res.json(projects);
        }).catch(err => {
            return res.status(500).json(err);
        });

    },
    getProjectDatasets: (req, res) => {
        const sanityProjectId = req.params.id;
        const sanityConnection = req.user.connections.find(con => con.type === 'sanity');
        if (!sanityConnection) {
            logger.debug('Sanity: No connection found');
            return res.status(404).send('Connection not found');
        }

        return SanityService.getProjectDatasets(sanityConnection.accessToken, sanityProjectId).then(datasets => {
            res.json(datasets);
        }).catch(err => {
            return res.status(500).json(err);
        });
    }
};
