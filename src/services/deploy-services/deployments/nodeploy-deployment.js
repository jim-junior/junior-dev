const Project = require('../../../models/project.model').default;

module.exports = {
    deploy: function (project, user, buildLogger) {
        return Project.updateBuildStatus(project._id, 'live');
    }
};
