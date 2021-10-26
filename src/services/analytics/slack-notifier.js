const axios = require('axios');
const config = require('../../config').default;
const _ = require('lodash');
const BASE_URL = 'https://hooks.slack.com/services/';

function slackWebhookApi(webhookId, content) {
    const sendNotifications = _.get(config, 'slack.sendNotifications');
    if (!sendNotifications) {
        return false;
    }
    return axios
        .post(BASE_URL + webhookId, JSON.stringify(content), {
            withCredentials: false
        })
        .catch(err => {
            console.error('Error sending slack notification', { error: err });
        });
}

function sendSlackNotification(message, data, {webhookId}) {
    const content = {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: message
                }
            },{
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: '```\n' + JSON.stringify(data, null, 4) + '\n```'
                }
            }
        ]
    };

    return slackWebhookApi(webhookId, content);
}

function sendSlackProjectMessage(webhookId, status, project, user, error) {
    const environment = config.env;

    let message = `
        *${status}*
        ${error ? `Error: ${error}` : ''}
        Project: ${project.name} - ${project.id} - *${environment}*
        User: ${user.email}
        Theme: ${_.get(project, 'wizard.theme.id')}
        SSG: ${_.get(project, 'wizard.ssg.id')}
        CMS: ${_.get(project, 'wizard.cms.id')}
    `.replace(/^\s+/gm, '');

    if (_.get(project, 'wizard.theme.id') === 'custom') {
        message += `
        source: ${_.get(project, 'wizard.theme.settings.source')}
        stackbitYmlFound: ${_.get(project, 'wizard.theme.settings.stackbitYmlFound')}
        stackbitYmlValid: ${_.get(project, 'wizard.theme.settings.stackbitYmlValid')}
        `.replace(/^\s+/gm, '');
    }

    message += `
        <${new URL(`/project/${project.id}`, config.build.adminBaseUrl)}|View Project>
        <${new URL(`/user/${user.id}`, config.build.adminBaseUrl)}|View User>
    `.replace(/^\s+/gm, '');

    const data = {
        text: message
    };

    return slackWebhookApi(webhookId, data);
}


module.exports = {
    sendSlackNotification,
    sendSlackProjectMessage
};
