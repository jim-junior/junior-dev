const _ = require('lodash');
const { pull: pullProject } = require('../../serverless/functions');
const logger = require('../../services/logger');


module.exports = {
    pullProject: (req, res) => {
        const { projectId } = req.params;

        logger.debug('Server: pulling for project', {projectId});
        return pullProject(projectId, _.assign(req.query, req.body))
            .then((pages) => {
                res.json(pages);
            })
            .catch((err) => {
                logger.log(err.level || 'error', 'server: Stackbit Functions Pull Failed:', {projectId: projectId, error: err});
                res.status(err.status || 500).json(err);
            });
    }
};
