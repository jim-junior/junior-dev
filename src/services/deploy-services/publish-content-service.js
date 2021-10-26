const aws = require('aws-sdk');
const _ = require('lodash');
const { format } = require('date-fns');
const config = require('../../config').default;
const { BuildLogger } = require('../../services/build-logger');
const Project = require('../../models/project.model').default;
const { NoChangesToPublish } = require('../../routers/response-errors');
const shouldPublishDrafts = true;
const scheduleEvenPrefix = 'SCHEDULED_PUBLISH_EVENT';
const publishTargetId = 'publishTarget';

module.exports = {
    publishContent: (project, user, { objects, type }, environmentName) => {
        // hack to prevent circular dependencies
        // cmss has to be slit up into 2 files
        // e.g. contentful => contentful-pub (publish content, create spaces etc), contentful-sub (for webhooks => triggering builds etc)
        const cmsTypes = require('./cmss');

        if (shouldPublishDrafts && _.get(project, 'deploymentData.container')) {
            const buildLogger = new BuildLogger(project.id, user.id);
            return cmsTypes.baseInvokeContentSourcesWithProject('hasChanges', project, user, { objects, type }, environmentName).then(({ hasChanges, changedObjects }) => {
                if (!hasChanges) {
                    throw NoChangesToPublish;
                }

                return cmsTypes.baseInvokeContentSourcesWithProject(
                    'publishDrafts',
                    project,
                    user,
                    {
                        objects: changedObjects,
                        type
                    },
                    environmentName,
                    buildLogger
                );
            });
        }

        return Promise.resolve(project);
    },
    setPublishingVersionToLatestContentVersion: (project, environmentName) => {
        if (_.get(project, 'deploymentData.container')) {
            return Project.updateDeploymentData(project.id, 'container', {
                publishingVersion: Project.latestContentVersion(project, environmentName)
            }, environmentName);
        }

        return Promise.resolve(project);
    },
    setPublishedVersionToPublishingVersion: (project, environmentName) => {
        const publishingVersion = project.getDeploymentData('container.publishingVersion', environmentName);
        if (_.get(project, 'deploymentData.container') && publishingVersion) {
            return Project.updateDeploymentData(project.id, 'container', {
                publishedVersion: publishingVersion,
                publishingVersion: ''
            }, environmentName);
        }

        return Promise.resolve(project);
    },
    removePublishingVersion: (project, environmentName) => {
        if (_.get(project, 'deploymentData.container')) {
            return Project.updateDeploymentData(project.id, 'container', {
                publishingVersion: ''
            }, environmentName);
        }

        return Promise.resolve(project);
    },

    schedulePublish: async ({ project, user, utcScheduledDate, scheduleToken }) => {
        const projectId = _.get(project, 'id');
        const userId = _.get(user, 'id');
        const eventId = getScheduleEventId(projectId);

        const date = new Date(utcScheduledDate);
        // convert 2020-05-26T20:51:45.079Z => cron(51 20 26 05 ? 2020)
        const cron = `${format(date, 'mm')} ${format(date, 'HH')} ${format(date, 'dd')} ${format(date, 'MM')} ? ${format(date, 'yyyy')}`;

        const params = {
            Name: eventId,
            ScheduleExpression: `cron(${cron})`
        };

        const eventBridge = new aws.EventBridge();
        const lambda = new aws.Lambda();

        const ruleData = await eventBridge.putRule(params).promise();
        const functionPolicy = await lambda.getPolicy({ FunctionName: config.scheduledPublish.lambdaArn }).promise();

        const targetParams = {
            Rule: eventId,
            Targets: [
                {
                    Arn: config.scheduledPublish.lambdaArn,
                    Id: publishTargetId,
                    Input: JSON.stringify({
                        projectId,
                        userId,
                        scheduleToken,
                        hostName: config.env === 'local' ? config.server.webhookHostname : config.server.hostname
                    })
                }
            ]
        };

        let policy;
        try {
            policy = JSON.parse(functionPolicy.Policy);
        } catch (e) {
            throw e;
        }

        if (_.find(policy.Statement, { Sid: eventId })) {
            return eventBridge.putTargets(targetParams).promise();
        } else {
            const lambdaParams = {
                Action: 'lambda:InvokeFunction',
                Principal: 'events.amazonaws.com',
                SourceArn: ruleData.RuleArn,
                FunctionName: config.scheduledPublish.lambdaArn,
                StatementId: eventId
            };

            await lambda.addPermission(lambdaParams).promise();
            return eventBridge.putTargets(targetParams).promise();
        }
    },

    removeScheduledPublish: ({ project }) => {
        const projectId = _.get(project, 'id');
        const eventId = getScheduleEventId(projectId);
        const eventBridge = new aws.EventBridge();
        return eventBridge
            .removeTargets({
                Ids: [publishTargetId],
                Rule: eventId,
                Force: true
            })
            .promise(() => {
                return eventBridge.deleteRule({ Name: eventId, Force: true }).promise();
            });
    }
};

const getScheduleEventId = projectId => {
    return `${scheduleEvenPrefix}_${projectId}`;
};
