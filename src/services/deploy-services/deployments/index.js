const _ = require('lodash');

/**
 * Interface
 * deploy: (project, user, buildLogger)
 * postDeploy: (project, user, buildLogger)
 * triggerBuild: (project, user, payload)
 * triggerAutoBuild: (project, user, payload, action)
 * updateProjectDeploymentData: (project, user, params)
 * setDeploymentBuildProgress: (project, buildProgress, buildParams)
 * buildProject: (project, user, buildLogger)
 * createAPIKey: (project, user)
 * redeploy: (project, user, buildLogger)
 * destroy: (project, user, buildLogger)
 */

const containerTypes = {
    sharedContainer: require('./shared-container-deployment')
};

const deploymentTypes = {
    container: require('./container-deployment'),
    netlify: require('./netlify-deployment'),
    azure: require('./azure-deployment'),
    digitalocean: require('./digitalocean-deployment')
};

module.exports = {
    callDeploymentMethodForProject: callDeploymentMethodForProject,
    callPureDeploymentMethodForProject: callPureDeploymentMethodForProject,
    sharedContainer: require('./shared-container-deployment'),
    netlify: require('./netlify-deployment')
};

function getDeploymentTypeForProject(project) {
    return _.get(deploymentTypes, _.get(project, 'wizard.deployment.id', null));
}

function getContainerTypeForProject(project) {
    return _.get(containerTypes, _.get(project, 'wizard.container.id'));
}

function callDeploymentMethodForProject(methodName, project, ...args) {
    const container = getContainerTypeForProject(project);

    if (container) {
        const containerFunc = _.get(container, methodName);
        if (!_.isFunction(containerFunc)) {
            return Promise.resolve(project);
        }
        return containerFunc(project, ...args);
    }

    return callPureDeploymentMethodForProject(methodName, project, ...args);
}


function callPureDeploymentMethodForProject(methodName, project, ...args) {
    let deployment = getDeploymentTypeForProject(project);

    if (!deployment) {
        return Promise.resolve(project);
    }

    const func = _.get(deployment, methodName);
    if (!_.isFunction(func)) {
        return Promise.resolve(project);
    }

    return func(project, ...args);
}
