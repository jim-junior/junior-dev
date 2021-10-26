const _ = require('lodash');
const logger = require('../../services/logger');
const Project = require('../../models/project.model').default;
const ContentfulProjectService = require('../../services/contentful-services/contentful-project-service');
const {fetchEntry} = require('../../services/contentful-services/contentful-api-service');
const {normalizeSlug} = require('../../serverless/cms/cms-common-utils');

module.exports = {
    getContentful: (req, res) => {
        const {spaceId, entryId} = req.params;
        const userId = req.user.id;

        return Project.getProjectBySpaceId({userId, spaceId, CMS: 'contentful'})
            .then(([project]) => {
                if (!project) {
                    const error = new Error('There are no projects for current logged in user. Try login with another account.');
                    error.status = 403;
                    throw error;
                }
                return project;
            })
            .then(project => {
                const {deploymentData} = project;
                // for backward compatibility use deployKey
                const space = ContentfulProjectService.getSpaceById(project, spaceId);
                const accessToken = space.previewApiKey || space.deployKey;
                const environment = _.get(space, 'environment', 'master');
                const previewId = _.get(deploymentData, 'container.lastPreviewId');
                const containerName = _.get(deploymentData, 'container.name');
                if (accessToken && previewId && containerName) {
                    return fetchEntry({
                        spaceId,
                        entryId,
                        accessToken,
                        environment
                    }).then(({data}) => {
                        const urlPath = normalizeSlug(data.fields.stackbit_url_path);
                        return {
                            redirectUrl: `https://preview--${containerName}.stackbit.dev/${urlPath}?preview=${previewId}`
                        };
                    });
                } else {
                    const error = new Error('No preview page available for current entry.');
                    error.status = 403;
                    throw error;
                }
            })
            .then(({redirectUrl}) => {
                return res.status(301).redirect(redirectUrl);
            })
            .catch(err => {
                if (err.status === 403) {
                    // @todo redirect to styled Stackbit page
                    return res.status(err.status).send(err.message);
                } else {
                    return res.status(err.status || 500).send(err);
                }
            });
    }
};
