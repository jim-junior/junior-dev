const config = require('../../config').default;
const Project = require('../../models/project.model').default;
const CollaboratorRole = require('../../models/collaborator-role.model').default;
const analytics = require('../analytics/analytics');
const { requestPublishEmail, requestedPublishDoneEmail } = require('../customerio-service/customerio-transactional-service');

function projectUrl(project) {
    return `${config.server.clientOrigin}/studio/${project.id}/`;
}

async function addRequestedPublish(project, requester, text) {
    await project.addRequestedPublish(requester, new Date(), text);
    analytics.track('Requested Publish', { projectId: project.id }, requester);
    const publishers = await project.listUsersByPermission(CollaboratorRole.Permission.PUBLISH_SITE);
    await Promise.all(
        publishers
            .filter(publisher => publisher.email)
            .map(publisher => requestPublishEmail(publisher, {
                projectName: project.name,
                projectUrl: projectUrl(project),
                requesterEmail: requester.email,
                requestText: text
            }))
    );
}

async function notifyRequestedPublishes(project, user) {
    const usersToNotify = await project.resolveRequestedPublishes();
    await Promise.all(
        usersToNotify
            .filter(requester => requester.email)
            .map(requester => {
                analytics.track('Requested Publish Done Email Sent', { projectId: project.id }, requester);
                return requestedPublishDoneEmail(requester, {
                    projectName: project.name,
                    projectUrl: projectUrl(project),
                    siteUrl: project.siteUrl,
                    publisherEmail: user.email
                });
            })
    );
}

module.exports = {
    addRequestedPublish,
    notifyRequestedPublishes
};
