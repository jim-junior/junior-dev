const _ = require('lodash');
const aws = require('aws-sdk');
const config = require('../../config').default;
const Project = require('../../models/project.model').default;
const User = require('../../models/user.model').default;
const logger = require('../../services/logger');

const containerOrchestrator = require('../deploy-services/container-orchestration-service');

async function getTasks(nextToken) {
    const ecs = new aws.ECS({
        region: 'us-east-1'
    });
    const listTasksResult = await ecs.listTasks({
        cluster: config.container.shared.taskDetails.cluster,
        maxResults: 100,
        nextToken
    }).promise();
    const taskArns = _.get(listTasksResult, 'taskArns');
    if (_.isEmpty(taskArns)) {
        return taskArns;
    }
    const describeTasksResult = await ecs.describeTasks({
        tasks: taskArns,
        cluster: config.container.shared.taskDetails.cluster
    }).promise();
    const tasks = _.get(describeTasksResult, 'tasks', []);
    if (listTasksResult.nextToken) {
        tasks.push(...(await getTasks(listTasksResult.nextToken)));
    }
    return tasks;
}

async function getLatestContainerVersion(taskDefinition) {
    const ecs = new aws.ECS({
        region: 'us-east-1'
    });
    const taskDefinitionInfo = await ecs.describeTaskDefinition({taskDefinition}).promise();
    const dockerImage = _.get(taskDefinitionInfo, 'taskDefinition.containerDefinitions[0].image');
    if (!dockerImage) {
        return;
    }
    // convert image of format '211184604168.dkr.ecr.us-east-1.amazonaws.com/stackbit-container-ecr:develop'
    // to repository name and tag
    const [repositoryName, imageTag] = dockerImage.split('/')[1].split(':')
    const ecr = new aws.ECR({
        region: 'us-east-1'
    });
    const imageInfo = await ecr.describeImages({
        repositoryName,
        imageIds: [{
            imageTag
        }]
    }).promise();
    // find tag with format {tag}-{version}
    const versionTag = _.find(
        _.get(imageInfo, 'imageDetails[0].imageTags', []),
        tag => tag.startsWith(imageTag + '-')
    );
    if (!versionTag) {
        return;
    }
    const version = versionTag.substring(imageTag.length + 1);
    return version;
}

module.exports = {
    getContainers: async () => {
        const tasks = await getTasks();
        const result = tasks.map(async task => {
            const environment = _.get(task, 'overrides.containerOverrides[0].environment', {}).reduce((accum, env) => {
                accum[env.name] = env.value;
                return accum;
            }, {});
            const item = {
                ...(_.pick(task, [
                    'taskArn', 'healthStatus', 'createdAt', 'startedAt', 'taskDefinitionArn', 'containerInstanceArn'
                ])),
                env: _.get(environment, 'CONFIG_ENV'),
                projectId: _.get(environment, 'STACKBIT_PROJECT_ID'),
                containerName: _.get(environment, 'CONTAINER_NAME'),
                ssg: _.get(environment, 'SSG_TYPE'),
                cms: _.get(environment, 'CMS_TYPE'),
                apiUrl: _.get(environment, 'STACKBIT_API_URL'),
                configUrl: _.get(environment, 'CONFIG_URL')
            };
            if (item.projectId) {
                const project = await Project.findById(item.projectId);
                if (project) {
                    item.hasProject = true;
                    item.shouldHibernate = _.get(project, 'shouldHibernate', true);
                    item.lastActivity = _.get(project, 'deploymentData.container.lastActivity');
                    item.url = _.get(project, 'deplomentData.container.url');
                    item.version = _.get(project, 'deploymentData.container.version');
                    item.ssg = item.ssg || _.get(project, 'wizard.ssg.id');
                    item.cms = item.cms || _.get(project, 'wizard.cms.id');
                }
            }
            return item;
        });
        return Promise.all(result);
    },
    upgradeContainers: async () => {
        // To simplify the process we require that all latest docker images are of the same container version.
        // We verify this and stop if that's not the case.
        // This allows us to avoid repeating the entire process for each container image.
        const taskDefinitions = [
            config.container.shared.genericTaskDefinition,
            ...Object.values(config.container.shared.prepackagedTaskDefinitions)
        ];
        logger.debug('[admin-container-service] finding latest version for task definitions', {taskDefinitions});
        const latestVersions = await Promise.all(taskDefinitions.map(taskDefinition => getLatestContainerVersion(taskDefinition)));
        const uniqueLatestVersions = _.uniq(latestVersions);
        if (uniqueLatestVersions.length !== 1) {
            logger.error('[admin-container-service] not all task definitions have the same latest version. can\'t continue...', {taskDefinitions, latestVersions});
            return;
        }
        const latestVersion = uniqueLatestVersions[0];
        logger.debug('[admin-container-service] detected latest version', {latestVersion});
        const candidateProjects = await Project.findUpgradeableContainerProjects(latestVersion);
        if (_.isEmpty(candidateProjects)) {
            logger.debug('[admin-container-service] nothing found to upgrade', {latestVersion});
            return;
        }
        const project = candidateProjects[0];
        logger.debug(`[admin-container-service] found ${candidateProjects.length} to upgrade. proceeding with ${project.id}`, {latestVersion, projectId: project.id});
        await containerOrchestrator.upgrade(project, logger);
    }
};
