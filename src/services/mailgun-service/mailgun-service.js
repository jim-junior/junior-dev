const config = require('../../config').default;
const mailgun = require('mailgun-js')({ apiKey: config.mailgun.apiKey, domain: config.mailgun.domain });
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const forgotPasswordTemplate = fs.readFileSync(path.join(__dirname, './forgot-password-template.html'), 'utf8');
const forgotPasswordNoUserTemplate = fs.readFileSync(path.join(__dirname, './forgot-password-no-user-template.html'), 'utf8');
const verifyEmailTemplate = fs.readFileSync(path.join(__dirname, './verify-email-template.html'), 'utf8');

function forgotPasswordEmail(user, resetPasswordToken, email) {
    let data;
    if (user && user.email) {
        const actionUrl = `${config.server.clientOrigin}/reset-password?resetPasswordToken=${resetPasswordToken}`;
        let template = forgotPasswordTemplate.replace(new RegExp('{{action_url}}', 'g'), actionUrl);

        data = {
            from: config.mailgun.fromAddress,
            to: user.email,
            subject: 'Stackbit - Password reset information',
            html: template
        };
    } else {
        const actionUrl = `${config.server.clientOrigin}/forgot-password`;
        let template = forgotPasswordNoUserTemplate.replace(new RegExp('{{action_url}}', 'g'), actionUrl);

        data = {
            from: config.mailgun.fromAddress,
            to: email,
            subject: 'Stackbit - Password reset information',
            html: template
        };
    }

    return mailgun
        .messages()
        .send(data)
        .then((body) => {
            logger.debug('[forgotPasswordEmail] Mailgun success', body);
            return body;
        })
        .catch((err) => {
            logger.debug('[forgotPasswordEmail] Mailgun error', err);
            throw { status: err.statusCode, name: 'mailgun-error', message: err.message };
        });
}

function sendValidationEmail(email, validationToken) {
    logger.debug(`[sendValidationEmail] Mailgun send to ${email}`);
    const actionUrl = `${config.server.clientOrigin}/validate-email?validationToken=${validationToken}`;
    let template = verifyEmailTemplate.replace(new RegExp('{{action_url}}', 'g'), actionUrl);

    if (config.mailgun.sendToTestAccount) {
        email = config.mailgun.testAccount;
    }

    const data = {
        from: config.mailgun.fromAddress,
        to: email,
        subject: 'Stackbit - Please verify your email address',
        html: template
    };

    return mailgun
        .messages()
        .send(data)
        .then((body) => {
            logger.debug('[sendValidationEmail] Mailgun success', body);
            return body;
        })
        .catch((err) => {
            logger.debug('[sendValidationEmail] Mailgun error', err);
            throw err;
        });
}

function sendContainerTrialEmail(email, project) {
    if (config.mailgun.sendToTestAccount) {
        email = config.mailgun.testAccount;
    }
    logger.debug(`[sendContainerTrialEmail] Mailgun send to ${email}`);

    let body = `
A new trial has been created \n
Project Name: ${project.name}\n
Project ID: ${project.id}\n
User ID: ${project.ownerId}\n
-------------------------\n
SSG: ${project.wizard.ssg.title}\n
CMS: ${project.wizard.cms.title}\n
Github Repo: ${project.wizard.theme.settings.source}\n
View project in admin dashboard: https://admin.stackbit.com/project/${project.id}`;

    const data = {
        from: config.mailgun.fromAddress,
        to: email,
        subject: `New Trial Container - ${project.id}`,
        text: body
    };

    return mailgun
        .messages()
        .send(data)
        .then((body) => {
            logger.debug('[sendContainerTrialEmail] Mailgun success', body);
            return body;
        })
        .catch((err) => {
            logger.debug('[sendContainerTrialEmail] Mailgun error', err);
            throw err;
        });
}

module.exports = {
    forgotPasswordEmail,
    sendValidationEmail,
    sendContainerTrialEmail,
};
