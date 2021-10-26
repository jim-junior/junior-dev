const fs = require('fs');
const os = require('os');
const aws = require('aws-sdk');
const path = require('path');
const mongoose = require('mongoose');

const Project = require('../../models/project.model').default;
const logger = require('../../services/logger');
const config = require('../../config').default;
const User = require('../../models/user.model').default;
const _ = require('lodash');
const blacklist = require('../../services/admin-service/theme-blacklist');
const { BackupAndUploadWithConfig, getBackups } = require('../../services/mongo-backup-service/mongo-backup');
const { sendSlackNotification } = require('../../services/analytics/slack-notifier');
const ResponseError = require('../response-errors');
const insightService = require('../../services/analytics/insights-service');
const classificationService = require('../../services/project-services/classification-service');
const projectService = require('../../services/project-services/project-service');
const gitService = require('../../services/deploy-services/git-service');
const adminContainerService = require('../../services/admin-service/container-service');
const { analyze } = require('../../services/project-services/import-project.service');

module.exports = {
    countUsers: (req, res) => {
        return User.countDocuments()
            .then((count) => {
                return res.json(count);
            })
            .catch((err) => {
                return res.status(err.status || 500).json(err);
            });
    },
    getUsers: async (req, res) => {
        try {
            let filter = {};
            filter.temporary = false;
            const limit = parseInt(req.query.limit) || 50000;
            const sort = { createdAt: -1 };

            const [count, docs] = await Promise.all([
                User.countDocuments(),
                User.aggregate([
                    {
                        $match: {
                            ...filter
                        }
                    },
                    {
                        $sort: sort
                    },
                    {
                        $limit: limit
                    },
                    {
                        $project: {
                            _id: 1,
                            email: 1,
                            createdAt: 1
                        }
                    }
                ]).option({ allowDiskUse: true }),
            ]);

            const result = {
                count,
                total: docs.length,
                limit,
                data: docs
            };
            return res.json(result);
        } catch (err) {
            return res.status(err.status || 500).json(err);
        }
    },
    getUserById: (req, res) => {
        const { id } = req.params;
        return User.findOne({ _id: id })
            .then((user) => {
                res.json(user);
            })
            .catch((err) => {
                return res.status(err.status || 500).json(err);
            });
    },
    queryUsers: async (req, res) => {
        try {
            const filter = {
                temporary: false,
                ...req.body
            };

            if (req.body._id) {
                const validId = mongoose.Types.ObjectId.isValid(req.body._id);
                if (validId) {
                    filter._id = mongoose.Types.ObjectId(req.body._id);
                } else {
                    throw new Error('invalidUserId');
                }
            }

            if (req.body.email) {
                const escapedEmail = req.body.email.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
                filter.email = { $regex: new RegExp(escapedEmail, 'ig') };
            }

            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 5000;
            const skip = (page - 1) * limit;
            const sort = { createdAt: -1 };

            const [count, docs] = await Promise.all([
                User.countDocuments(filter),
                User.find(
                    filter,
                    {
                        id: 1,
                        email: 1,
                        createdAt: 1
                    },
                    { skip, limit, sort }
                )
            ]);

            const data = docs.map((doc) => doc.toObject());
            const result = {
                count,
                total: docs.length,
                page,
                limit,
                skip,
                data
            };
            return res.json(result);
        } catch (err) {
            const responseError = { status: err.status || 500, name: 'queryError', message: 'Error querying database' };
            if (err.kind === 'ObjectId' || err.message === 'invalidUserId') {
                responseError.message = 'Invalid user ID';
            }
            return res.status(err.status || 500).json(responseError);
        }
    },
    getAuthenticatedRepo: (req, res) => {
        const { id } = req.params;
        const { repoUrl } = req.body;
        return User.findOne({ _id: id })
            .then((user) => {
                const accessToken = user.githubAccessToken;
                const repoSuffix = repoUrl.replace('https://', '').replace('http://', '');
                res.json({
                    authRepoUrl: `https://${accessToken}:x-oauth-basic@${repoSuffix}`
                });
            })
            .catch((err) => {
                return res.status(err.status || 500).json(err);
            });
    },
    analyzeRepo: (req, res) => {
        const { id } = req.params;
        const { repoUrl, branch } = req.body;
        return User.findOne({ _id: id })
            .then((user) => {
                return analyze(user, repoUrl, branch, null, 'Admin Panel').then((result) => {
                    res.json(result);
                });
            })
            .catch((err) => {
                return res.status(err.status || 500).json(err);
            });
    },
    getUser: (req, res) => {
        if (_.isEmpty(req.query)) {
            return res.json(null);
        }
        return User.findOne(req.query)
            .then((user) => {
                res.json(user);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    getProjectsByUserId: (req, res) => {
        const ownerId = req.params.userId;
        return Project.findProjectsWithDeletedForUser(ownerId)
            .then((project) => {
                res.json(project);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    countProjects: (req, res) => {
        return Project.countDocuments()
            .then((count) => {
                return res.json(count);
            })
            .catch((err) => {
                return res.status(err.status || 500).json(err);
            });
    },
    getProjects: (req, res) => {
        let filter = {};
        filter.buildStatus = { $ne: 'draft' };

        const limit = parseInt(req.query.limit) || 50000;
        const sort = { createdAt: -1 };

        Project.countDocuments().then((count) => {
            return Project.aggregate([
                {
                    $match: {
                        ...filter
                    }
                },
                {
                    $sort: sort
                },
                {
                    $limit: limit
                },
                {
                    $lookup: {
                        from: 'users',
                        localField: 'ownerId',
                        foreignField: '_id',
                        as: 'user'
                    }
                },
                {
                    $unwind: '$user'
                },
                {
                    $project: {
                        _id: 1,
                        ownerId: 1,
                        email: '$user.email',
                        deleted: 1,
                        createdAt: 1,
                        deployedAt: 1,
                        buildStatus: 1,
                        siteUrl: 1,
                        theme: '$wizard.theme.id',
                        ssg: '$wizard.ssg.id',
                        cms: '$wizard.cms.id',
                        deploys: '$metrics.deploySuccessCount',
                        tierId: '$subscription.tierId'
                    }
                }
            ])
                .option({ allowDiskUse: true })
                .then((data) => {
                    const result = {
                        count,
                        total: data.length,
                        limit,
                        data
                    };
                    return res.json(result);
                })
                .catch((err) => {
                    res.status(err.status || 500).json(err);
                });
        });
    },
    queryProjects: async (req, res) => {
        try {
            const filter = { ...req.body };

            if (req.body._id) {
                const validId = mongoose.Types.ObjectId.isValid(req.body._id);
                if (validId) {
                    filter._id = mongoose.Types.ObjectId(req.body._id);
                } else {
                    throw new Error('invalidProjectId');
                }
            }

            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 5000;
            const skip = (page - 1) * limit;
            const sort = { createdAt: -1 };

            const [count, docs] = await Promise.all([
                Project.countDocuments(filter),
                Project.find(
                    filter,
                    {
                        _id: 1,
                        ownerId: 1,
                        createdAt: 1,
                        deleted: 1,
                        deployedAt: 1,
                        buildStatus: 1,
                        siteUrl: 1,
                        theme: '$wizard.theme.id',
                        ssg: '$wizard.ssg.id',
                        cms: '$wizard.cms.id',
                        deploys: '$metrics.deploySuccessCount',
                        tierId: '$subscription.tierId'
                    },
                    { skip, limit, sort }
                )
            ]);

            const data = docs.map((doc) => doc.toObject());
            const result = {
                count,
                total: docs.length,
                page,
                limit,
                skip,
                data
            };
            return res.json(result);
        } catch (err) {
            const responseError = { status: err.status || 500, name: 'queryError', message: 'Error querying database' };
            if (err.message) {
                responseError.message = err.message;
            }
            return res.status(err.status || 500).json(responseError);
        }
    },
    updateProject: (req, res) => {
        const { id } = req.params;
        const { key, value } = req.body;
        return Project.updateProjectAdmin(id, key, value)
            .then((project) => {
                if (!project) {
                    throw ResponseError.NotFound;
                }
                res.json(project);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    updateProjectRealScoreAutoScore: (req, res) => {
        const { id } = req.params;
        return Project.updateProjectRealScoreAutoScore(id)
            .then((realScore) => {
                res.json(realScore);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    getProjectById: (req, res) => {
        const { id } = req.params;
        return Project.findOneWithDeleted({ _id: id })
            .then((project) => {
                res.json(project);
            })
            .catch((err) => {
                return res.status(err.status || 500).json(err);
            });
    },
    getProject: (req, res) => {
        if (_.isEmpty(req.query)) {
            return res.json(null);
        }
        return Project.findOne(req.query)
            .then((project) => {
                res.json(project);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    getContainers: (req, res) => {
        return adminContainerService
            .getContainers()
            .then((containers) => {
                res.json(containers);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    getCustomProjects: (req, res) => {
        return Project.aggregate([
            {
                $match: {
                    'wizard.theme.id': 'custom',
                    'wizard.theme.settings.source': { $nin: blacklist }
                }
            },
            {
                $project: {
                    name: 1,
                    ownerId: 1,
                    createdAt: 1,
                    deployedAt: { $ifNull: ['$deployedAt', null] },
                    deployCount: '$metrics.deployCount',
                    buildStatus: 1,
                    siteUrl: 1,
                    source: '$wizard.theme.settings.source'
                }
            }
        ])
            .then((rows) => {
                res.json(rows);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    getCustomProjectsTotals: (req, res) => {
        return Project.aggregate([
            {
                $match: {
                    'wizard.theme.id': 'custom',
                    'wizard.theme.settings.source': { $nin: blacklist }
                }
            },
            {
                $group: { _id: '$wizard.theme.settings.source', count: { $sum: 1 } }
            }
        ])
            .then((rows) => {
                res.json(rows);
            })
            .catch((err) => {
                res.status(err.status || 500).json(err);
            });
    },
    backupDB: async (req, res) => {
        try {
            const backupResult = await BackupAndUploadWithConfig(config);
            sendSlackNotification(
                'Manual database backup complete!',
                { env: config.env, filename: backupResult.data.Key },
                { webhookId: config.slack.mongoBackupWebhookId }
            );
            logger.debug('Manual database backup completed');
            res.status(204).end();
        } catch (err) {
            sendSlackNotification(
                'Failed to Backup MongoDB (manual)!',
                { env: config.env, error: err },
                { webhookId: config.slack.mongoBackupWebhookId }
            );
            logger.error('Manual database backup failed', err);
            res.status(500).end();
        }
    },
    maintenanceTasks: async (req, res) => {
        res.status(201).end();
        logger.debug('Maintenance tasks: starting');
        try {
            // Note: This task should run first, to minimize the chance that any other task will fail it.
            const backupResult = await BackupAndUploadWithConfig(config);
            sendSlackNotification(
                'Database backup complete!',
                { env: config.env, filename: backupResult.data.Key },
                { webhookId: config.slack.mongoBackupWebhookId }
            );
            logger.debug('Maintenance task: database backup completed');
        } catch (err) {
            sendSlackNotification(
                'Failed to Backup MongoDB!',
                { env: config.env, error: err },
                { webhookId: config.slack.mongoBackupWebhookId }
            );
            logger.error('Maintenance task: database backup failed', err);
        }
        try {
            await projectService.submitProjectDeployedNotificationEmails();
            logger.debug('Maintenance task: submitting project viewers notification emails done');
        } catch (err) {
            logger.error('Maintenance task: submitting project viewers notification emails failed', err);
        }
        try {
            await User.clearTemporaryUsers();
            logger.debug('Maintenance task: clearing temporary users completed');
        } catch (err) {
            logger.error('Maintenance task: clearing temporary users failed', err);
        }
        try {
            await Project.autoDowngradeExpiredProjects();
            logger.debug('Maintenance task: auto-downgrading expired projects completed');
        } catch (err) {
            logger.error('Maintenance task: auto-downgrading expired projects failed', err);
        }
        try {
            await Project.detectOutOfSyncPaidProjects();
            logger.debug('Maintenance task: detecting out-of-sync projects completed');
        } catch (err) {
            logger.error('Maintenance task: detecting out-of-sync projects failed', err);
        }
        try {
            await insightService.updateInsights();
            logger.debug('Maintenance task: updating insights completed');
        } catch (err) {
            logger.error('Maintenance task: updating insights failed', err);
        }
        try {
            await Project.bulkUpdateProjectsRealScores();
            logger.debug('Maintenance task: updating project real scores completed');
        } catch (err) {
            logger.error('Maintenance task: updating projects real scores failed', err);
        }
        try {
            await classificationService.classifyAndUpdateAllProjects();
            logger.debug('Maintenance task: classifying projects completed');
        } catch (err) {
            logger.error('Maintenance task: classifying projects failed', err);
        }
    },
    upgradeContainers: async (req, res) => {
        res.status(201).end();
        logger.debug('Upgrade containers: starting');
        try {
            await adminContainerService.upgradeContainers();
            logger.debug('Upgrade containers: done');
        } catch (err) {
            logger.error('Upgrade containers: error occurred', err);
        }
    },
    getBackups: (req, res) => {
        return getBackups({
            bucketName: 'stackbit-mongodb-dump-dev',
            keyPrefix: config.env
        })
            .then((backups) => {
                res.json({ status: 'ok', result: backups });
            })
            .catch((err) => {
                return res.json({ status: 'fail', error: err });
            });
    },
    stopProject: (req, res) => {
        const projectId = req.params.id;
        return Project.findProjectById(projectId)
            .then((project) => {
                return User.findOne(project.ownerId).then((user) => {
                    return require('../../services/deploy-services/container-orchestration-service').hibernateContainer(
                        project,
                        user,
                        null
                    );
                });
            })
            .then(() => {
                res.json({ status: 'ok' });
            })
            .catch((err) => {
                return res.json({ status: 'fail', error: err });
            });
    },
    redeployProject: (req, res) => {
        const projectId = req.params.id;
        const environment = _.get(req, 'query.env');
        return Project.findProjectById(projectId)
            .then((project) => {
                return User.findOne(project.ownerId).then((user) => {
                    return require('../../services/deploy-services/deployments').callDeploymentMethodForProject(
                        'redeploy',
                        project,
                        user,
                        environment,
                        logger,
                        { force: true }
                    );
                });
            })
            .then(() => {
                res.json({ status: 'ok' });
            })
            .catch((err) => {
                return res.json({ status: 'fail', error: err });
            });
    },
    setContainerUrlForProject: (req, res) => {
        const projectId = req.params.id;
        const containerUrl = req.body.containerUrl;
        return Project.updateDeploymentData(projectId, 'container', {
            url: containerUrl,
            internalUrl: containerUrl
        })
            .then(() => {
                return Project.addAllowedHost(projectId, containerUrl);
            })
            .then(() => {
                res.json({ status: 'ok' });
            })
            .catch((err) => {
                return res.json({ status: 'fail', error: err });
            });
    },
    resetHealth: (req, res) => {
        const projectId = req.params.id;
        return Project.updateDeploymentData(projectId, 'container', {
            healthy: true,
            hibernating: false
        })
            .then(() => {
                res.json({ status: 'ok' });
            })
            .catch((err) => {
                return res.json({ status: 'fail', error: err });
            });
    },
    writeHeapdump: (req, res) => {
        logger.debug('[admin] write heapdump requested');
        if (!config.features.adminHeapdump) {
            logger.debug('[admin] write heapdump disabled on this env');
            return res.status(500).send();
        }
        if (_.get(req, 'body.token') !== req.user.id) {
            logger.debug('[admin] write heapdump with wrong token', { userId: req.user.id, token: _.get(req, 'body.token') });
            return res.status(400).send();
        }
        return new Promise((resolve, reject) => {
            const heapdump = require('heapdump');
            const fileName = `${config.env}_${new Date().toISOString()}.heapsnapshot`;
            const filePath = path.join(os.tmpdir(), fileName);

            heapdump.writeSnapshot(filePath, () => {
                logger.debug('heapdump done. uploading...');
                let fileStream = fs.createReadStream(filePath);
                fileStream.on('error', (err) => {
                    return reject({
                        error: 1,
                        message: err.message
                    });
                });
                const s3 = new aws.S3();
                let uploadParams = {
                    Bucket: 'stackbit-heapdumps',
                    Key: fileName,
                    Body: fileStream,
                    ACL: 'private'
                };
                s3.upload(uploadParams, (err, data) => {
                    logger.debug('heapdump upload done', { err, data });
                    if (err) {
                        reject(err);
                    }
                    resolve();
                    fs.unlinkSync(filePath);
                });
            });
        })
            .then(() => {
                res.json({ status: 'ok' });
            })
            .catch((err) => {
                return res.json({ status: 'fail', error: err });
            });
    },
    fetchInsights: (req, res) => {
        return insightService.updateInsights().then(() => {
            res.json({ status: 'ok' });
        });
    },
    classifyProjects: async (req, res) => {
        try {
            const projectIds = await Project.findNonDraftProjectIds();
            const results = [];
            for await (const result of classificationService.classifyProjects(projectIds)) {
                results.push(result);
            }
            res.json(results);
        } catch (err) {
            logger.error('Classify projects failed ', err);
            res.status(500).send();
        }
    },
    classifyProjectsAndSave: async (req, res) => {
        res.status(201).end();
        try {
            await classificationService.classifyAndUpdateAllProjects();
            logger.debug('Classify projects and save completed');
        } catch (err) {
            logger.error('Classify projects and save failed ', err);
        }
    },
    addPreviewBranch: async (req, res) => {
        const projectId = req.params.id;
        try {
            logger.debug('Adding preview branch', { projectId: projectId });
            const project = await Project.findProjectById(projectId);
            if (!project) {
                throw new Error('No project found: ' + projectId);
            }
            if (project.hasPreviewBranch()) {
                throw new Error('Preview branch already exists for: ' + projectId);
            }
            const url = _.get(project, 'deploymentData.github.sshURL');
            const privateKey = _.get(project, 'deploymentData.container.deployPrivateKey');
            const publicKey = _.get(project, 'deploymentData.container.deployPublicKey');
            const { publishBranch } = project.getContainerBranches();

            await gitService.createBranches(url, privateKey, publicKey, publishBranch, ['preview']);

            await Project.updateDeploymentData(projectId, 'container', {
                previewBranch: 'preview'
            });

            res.json({ status: 'ok' });

            logger.debug('Done adding preview branch', { projectId: projectId });
        } catch (err) {
            logger.error('Error adding preview branch', { projectId: projectId, err });
            return res.json({ status: 'fail', error: _.get(err, 'message') });
        }
    },
    notifyViewersCollaborators: async (req, res) => {
        const { period, projectId } = req.body;
        res.status(201).end();
        try {
            await projectService.submitProjectDeployedNotificationEmails(period, projectId);
            logger.debug('Submit project viewers notification emails completed');
        } catch (err) {
            logger.error('Submit project viewers emails failed ', err);
        }
    }
};
