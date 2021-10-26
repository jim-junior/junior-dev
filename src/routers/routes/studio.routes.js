const _ = require('lodash');
const logger = require('../../services/logger');
const Project = require('../../models/project.model').default;
const CollaboratorRole = require('../../models/collaborator-role.model').default;
const contentfulService = require('../../services/contentful-services/contentful-project-service');
const contentfulApiService = require('../../services/contentful-services/contentful-api-service');
const {getSitePreviewUrl, getSiteUrl} = require('../../services/deploy-services/container-service');

module.exports = {
    addContentfulSpaceToProject: (req, res, next) => {
        const {id} = req.params;
        const {spaceId} = req.body;
        const user = req.user;
        const contentfulConnection = _.find(user.connections, {type: 'contentful'});
        if (!spaceId || !contentfulConnection) {
            throw 'No space Id or Contentful Connection';
        }
        logger.debug('adding contentful space to project', {id, spaceId, contentfulConnection});
        return Project.findProjectByIdAndUser(id, user, CollaboratorRole.Permission.FULL_ACCESS).then(project=>{
            return contentfulApiService.getSpace(spaceId, contentfulConnection.accessToken).then(space=>{
                return contentfulApiService.createPersonalAccessToken(project, space, contentfulConnection.accessToken).then(manageKey => {
                    return contentfulApiService.createApiKeys(project, space, contentfulConnection.accessToken).then(apiKeys => {
                        logger.debug('got space and created keys', space, apiKeys, manageKey);
                        return contentfulService.addSpaceToProject(project, space, apiKeys, manageKey, true);
                    });
                });
            });
        }).then(project=>{
            res.json(project);
        }).catch(next);
    },
    migrateContentfulSpaceToArray: (req, res, next) => {
        const {id} = req.params;
        const user = req.user;
        logger.debug('migrating contentful space to array', {projectId: id});
        return Project.findProjectByIdAndUser(id, user, CollaboratorRole.Permission.FULL_ACCESS).then(project=>{
            const space = _.get(project, 'deploymentData.contentful');
            if (!space.spaceId) {
                return project;
            }
            return contentfulService.addSpaceToProject(
                project,
                { sys: { id: space.spaceId }, name: space.spaceName },
                {
                    deliveryApiKey: space.deliveryApiKey,
                    previewApiKey: space.previewApiKey
                },
                { token: space.manageKey },
                true
            );
        }).then(project=>{
            return Project.updateDeploymentData(project.id, 'contentful', {
                spaceId: null,
                spaceName: null,
                deliveryApiKey: null,
                previewApiKey: null,
                manageKey: null,
                nextSyncToken: null,
                url: null
            });
        }).then(project=>{
            res.json(project);
        }).catch(next);

    },
    enablePreview: (req, res, next) => {
        const {id} = req.params;
        const {containerName, hasHMR} = req.body;
        const user = req.user;
        logger.debug('Enabling preview for project', { projectId: id });
        return Project.findProjectByIdAndUser(id, user, CollaboratorRole.Permission.FULL_ACCESS)
            .then(project => {
                const previewId = 'f6e4dfac-56d2-4f90-bc0c-4b65b2ce8308';
                return Project.updateDeploymentData(project.id, 'container', {
                    lastPreviewId: previewId,
                    name: containerName,
                    hasHMR: hasHMR,
                    url: getSitePreviewUrl(project),
                    internalUrl: getSiteUrl(containerName, previewId),
                    publishedVersion: null,
                    publishingVersion: null
                });
            })
            .then(project => {
                res.json(project);
            })
            .catch(next);
    }
};
