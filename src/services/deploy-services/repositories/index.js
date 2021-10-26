const _ = require('lodash');
const repoTypes = {
    github: require('./github-deployment'),
    zip: require('./zip-deployment')
};

/**
 * Interface
 * deploy: (project, user, buildLogger)
 */

function getRepositoryTypeForProject(project) {
    return _.get(repoTypes, _.get(project, 'wizard.repository.id'));
}

function callRepositoryMethodForProject(methodName, project, ...args) {
    const repository = getRepositoryTypeForProject(project);
    if (!repository) {
        return Promise.resolve(project);
    }
    const func = _.get(repository, methodName);
    if (!_.isFunction(func)) {
        return Promise.resolve(project);
    }
    return func(project, ...args);
}

module.exports = {
    callRepositoryMethodForProject
};
