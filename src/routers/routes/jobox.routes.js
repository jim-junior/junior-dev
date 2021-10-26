const _ = require('lodash');
const logger = require('../../services/logger');
const joboxService = require('../../services/jobox-service/jobox-service');
const config = require('../../config').default;
const Project = require('../../models/project.model').default;
const crypto = require('crypto');

module.exports = {
    get: (req, res, next) => {
        const {joboxId} = req.params;
        logger.debug('Jobox webhook: get', {joboxId});
        return Project.findProjectByContainerName(joboxId).then(project => {
            const projectId = _.get(project, 'id');
            joboxService.getData(projectId).then(async siteData => {
                let token = _.get(project, 'deploymentData.container.adminToken');
                if (!token) {
                    await joboxService.updateToken(projectId).then(newToken => {
                        token = newToken;
                        return newToken;
                    });
                }
                return res.json({
                    status: 'ok',
                    siteUrl: config.jobox.siteUrlBase + _.get(project, 'deploymentData.container.name'),
                    siteAdminUrl: config.jobox.siteUrlBase + _.get(project, 'deploymentData.container.name') + '/admin/?token=' + token,
                    token: token,
                });
            }).catch(err => {
                return res.status(500).json(err);    
            });
        });
    },
    create: (req, res, next) => {
        const {joboxId} = req.params;
        logger.debug('Jobox webhook: create', {joboxId, body: req.body, headers: req.headers});
        return joboxService.create(joboxId, req).then(project => {
            const token = _.get(project, 'deploymentData.container.adminToken');
            res.json({
                status: 'ok',
                siteUrl: config.jobox.siteUrlBase + _.get(project, 'deploymentData.container.name'),
                siteAdminUrl: config.jobox.siteUrlBase + _.get(project, 'deploymentData.container.name') + '/admin/?token=' + token,
                token: token,
            });
        }).catch(next);
    },
    update: (req, res, next) => {
        const {joboxId} = req.params;
        logger.debug('Jobox webhook: update', {joboxId, body: req.body, headers: req.headers});
        return joboxService.update(joboxId, req).then(project => {
            const token = _.get(project, 'deploymentData.container.adminToken');
            res.json({
                status: 'ok',
                siteUrl: config.jobox.siteUrlBase + _.get(project, 'deploymentData.container.name'),
                siteAdminUrl: config.jobox.siteUrlBase + _.get(project, 'deploymentData.container.name') + '/admin/?token=' + token,
                token: token,
            });
        }).catch(next);
    },
    publish:  (req, res, next) => {
        const {joboxId} = req.params;
        logger.debug('Jobox webhook: republish', {joboxId, body: req.body, headers: req.headers});
        return joboxService.publish(joboxId, req).then(async project => {
            const projectId = _.get(project, 'id');
            let token = _.get(project, 'deploymentData.container.adminToken');
            if (!token) {
                await joboxService.updateToken(projectId).then(newToken => {
                    token = newToken;
                    return newToken;
                });
            }
            return res.json({
                status: 'ok',
                siteUrl: config.jobox.siteUrlBase + _.get(project, 'deploymentData.container.name'),
                siteAdminUrl: config.jobox.siteUrlBase + _.get(project, 'deploymentData.container.name') + '/admin/?token=' + token,
                token: token,
            });
        }).catch(next);
    },
    delete: (req, res, next) => {
        const {joboxId} = req.params;
        logger.debug('Jobox webhook: delete', {joboxId, body: req.body, headers: req.headers});
        return joboxService.remove(joboxId, req).then(() => {
            res.json({status: 'ok'});
        }).catch(next);
    },
    adminGet: (req, res, next) => {
        const {joboxId} = req.params;
        logger.debug('Jobox Admin: get', {joboxId, body: req.body, headers: req.headers});
        return Project.findProjectByContainerName(joboxId).then(project => {
            const projectId = _.get(project, 'id');
            joboxService.getData(projectId).then(siteData => res.json(siteData));
        }).catch(err => {
            return res.status(500).json(err);    
        });
    },
    adminUpdate: (req, res, next) => {
        const {joboxId} = req.params;
        logger.debug('Jobox Admin: update', {joboxId, body: req.body, headers: req.headers});
        return Project.findProjectByContainerName(joboxId).then(project => {
            const projectId = _.get(project, 'id');
            joboxService.getData(projectId).then(siteData => {
                const data = {
                    ...siteData,
                    ...req.body
                };
                joboxService.uploadPage(projectId, data, req.headers).then(() => {
                    logger.debug('uploadPage', data);
                    joboxService.publish(joboxId).then(project => {
                        res.json(data);
                    });
                });
            });
        }).catch(err => {
            return res.status(500).json(err);    
        });
    },
};