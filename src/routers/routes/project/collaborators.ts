import _ from 'lodash';
import type * as expressType from 'express';
import validator from 'validator';
import uuid from 'uuid/v4';
import Project, { ICollaboratorJSON, IProjectDoc } from '../../../models/project.model';
import CollaboratorRole from '../../../models/collaborator-role.model';
import EmailValidation from '../../../models/email-validation.model';
import User from '../../../models/user.model';
import { ResponseError } from '../../../services/utils/error.utils';
import analytics from '../../../services/analytics/analytics';
import { inviteCollaboratorEmail } from '../../../services/customerio-service/customerio-transactional-service';
import config from '../../../config';
import ScoreService from '../../../services/project-services/score-service';
import logger from '../../../services/logger';

interface CollaboratorResponse {
    id?: string;
    userId?: string;
    email?: string;
    role: typeof CollaboratorRole.name;
    invitationRole?: typeof CollaboratorRole.name;
}

async function getCollaboratorEmail(collaborator: ICollaboratorJSON) {
    if (!collaborator.userId) {
        // first condition clause is negated for the short case
        return collaborator.inviteEmail;
    } else {
        // the logic for when userId is set
        const collaboratorUser = await User.findUserById(collaborator.userId);
        const userEmail = collaboratorUser?.email;
        if (userEmail) {
            return userEmail;
        }

        if (collaboratorUser && collaboratorUser.emailVerification === 'pending') {
            const userValidation = await EmailValidation.getValidationByUserId(collaborator.userId);
            return userValidation?.email;
        }

        logger.debug('getCollaboratorEmail empty email', { collaboratorUserId: collaborator.userId });

        return '';
    }
}

function getCollaboratorRole(project: IProjectDoc, collaborator: ICollaboratorJSON) {
    const ownerId = project?.ownerId?.toString() ?? '';
    const collaboratorUserId = collaborator.userId ? collaborator.userId.toString() : '';

    if (collaboratorUserId && collaboratorUserId === ownerId) {
        return CollaboratorRole.OWNER.name;
    } else if (collaborator.status === 'invitation-sent') {
        return CollaboratorRole.INVITED.name;
    } else {
        return collaborator.roleOrDefault.name;
    }
}

export default {
    getCollaborators: async (req: expressType.Request, res: expressType.Response): Promise<void> => {
        try {
            const user = req.user;
            const projectId = req.params.id;

            if (!projectId || !user) {
                throw new ResponseError('NotFound');
            }

            const project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BASIC_ACCESS);
            if (!project) {
                throw new ResponseError('NotFound');
            }
            const collaborators = project.collaborators ?? [];
            const collaboratorsResponse: CollaboratorResponse[] = await Promise.all(
                collaborators.map(async (collaborator) => {
                    const email = await getCollaboratorEmail(collaborator);
                    const role = getCollaboratorRole(project, collaborator);
                    const result: CollaboratorResponse = {
                        id: collaborator.id,
                        userId: collaborator?.userId?.toString() ?? '',
                        email,
                        role
                    };
                    if (role === CollaboratorRole.INVITED.name) {
                        result.invitationRole = collaborator.roleOrDefault.name;
                    }
                    return result;
                })
            );

            let usersResponse: CollaboratorResponse[] = [];
            if (project.ownerId) {
                const owner = await User.findUserById(project.ownerId);
                usersResponse = [
                    {
                        id: owner?.id,
                        userId: owner?.id,
                        email: owner?.email,
                        role: CollaboratorRole.OWNER.name
                    }
                ];
            }
            usersResponse.push(...collaboratorsResponse);
            res.status(200).json(usersResponse);
        } catch (e) {
            logger.error('[getCollaborators] failed', { error: e, projectId: req?.params?.id, userId: req?.user?.id });

            if (e instanceof ResponseError) {
                res.status(e.status || 500).json({ message: e.message });
            } else {
                res.status(500).json({ message: 'Server error' });
            }
        }
    },
    inviteCollaborator: async (req: expressType.Request, res: expressType.Response): Promise<void> => {
        try {
            const user = req.user;
            const projectId = req.params.id;
            const { email, role } = req.body;

            if (!projectId || !user) {
                throw new ResponseError('NotFound');
            }

            if (!validator.isEmail(email)) {
                throw new ResponseError('InvalidCollaboratorEmail', { email });
            }

            if (!CollaboratorRole.isValidNonPhantomRole(role)) {
                throw new Error(`Unable to add collaborator role: ${role}`);
            }

            let project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.MANAGE_COLLABORATORS);

            if (!project || !project?.id) {
                throw new ResponseError('NotFound');
            }

            if (!project.checkTierAllowanceForFeature('collaborators', { role })) {
                throw new ResponseError('ProjectTierExceeded');
            }

            const inviteToken = uuid();
            project = await Project.addInvitedCollaborator(project, user, { inviteToken, inviteEmail: email, role });

            if (!project?.id || !project?.name || !user?.email) {
                throw new Error('Error adding collaborator');
            }

            analytics.track(
                'Collaborators Invite Collaborator',
                {
                    projectId: project.id,
                    userId: user.id,
                    collaboratorRole: role
                },
                user
            );

            await inviteCollaboratorEmail(email, {
                projectName: project.name,
                inviterEmail: user.email,
                inviteUrl: `${config.server.clientOrigin}/project/${project._id}/accept-collaborator-invite?token=${inviteToken}`,
                collaboratorRole: role
            });
            res.status(200).json(project);
            ScoreService.addScoreForAction('collaboratorInvite', projectId);
        } catch (e) {
            logger.error('[inviteCollaborator] failed', { error: e, projectId: req?.params?.id, userId: req?.user?.id });

            if (e instanceof ResponseError) {
                res.status(e.status || 500).json({ message: e.message });
            } else {
                res.status(500).json({ message: 'Server error' });
            }
        }
    },
    removeCollaborator: async (req: expressType.Request, res: expressType.Response): Promise<void> => {
        try {
            const user = req.user;
            const projectId = req.params.id;
            const collaboratorId = req.params.collaboratorId || req.body.collaboratorId;

            if (!collaboratorId) {
                logger.error('[removeCollaborator] no collaboratorId provided', { userId: req?.user?.id, projectId });
                throw new ResponseError('UnsupportedOperation');
            }

            if (!projectId || !user) {
                throw new ResponseError('NotFound');
            }

            let project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.MANAGE_COLLABORATORS);

            if (!project) {
                throw new ResponseError('NotFound');
            }

            project = await Project.removeCollaboratorById(project, collaboratorId);
            res.status(200).json(project);
        } catch (e) {
            logger.error('[removeCollaborator] failed', { error: e, projectId: req?.params?.id, userId: req?.user?.id });

            if (e instanceof ResponseError) {
                res.status(e.status || 500).json({ message: e.message });
            } else {
                res.status(500).json({ message: 'Server error' });
            }
        }
    },
    updateCollaborator: async (req: expressType.Request, res: expressType.Response): Promise<void> => {
        try {
            const user = req.user;
            const projectId = req.params.id;
            const collaboratorId = req.params.collaboratorId;

            if (!projectId || !user || !collaboratorId) {
                throw new ResponseError('NotFound');
            }

            let project = await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.MANAGE_COLLABORATORS);

            if (!project) {
                throw new ResponseError('NotFound');
            }

            const update = _.pick(req.body, ['role']);
            if (update.role && !CollaboratorRole.isValidNonPhantomRole(update.role)) {
                throw new Error(`Role ${update.role} is not valid`);
            }

            const collaborator = project.collaborators?.find(({ id }) => id === collaboratorId);
            if (!collaborator) {
                throw new ResponseError('CollaboratorDoesNotExist');
            }
            const updateRole = update.role;
            if (
                update.role !== CollaboratorRole.UNLICENSED.name &&
                !project.checkTierAllowanceForFeature('collaborators', { role: updateRole })
            ) {
                throw new ResponseError('ProjectTierExceeded');
            }
            project = await Project.updateCollaboratorById(project, collaboratorId, update);
            res.status(200).json(project);
        } catch (e) {
            logger.error('[updateCollaborator] failed', { error: e, projectId: req?.params?.id, userId: req?.user?.id });

            if (e instanceof ResponseError) {
                res.status(e.status || 500).json({ message: e.message });
            } else {
                res.status(500).json({ message: 'Server error' });
            }
        }
    },
    checkCollaboratorToken: async (req: expressType.Request, res: expressType.Response): Promise<void> => {
        try {
            const projectId = req.params.id;
            const token = req?.query?.token?.toString();

            if (!token) {
                throw new ResponseError('CollaboratorTokenNotProvided');
            }

            if (!projectId) {
                throw new ResponseError('NotFound');
            }

            const project = await Project.findProjectByIdAndCollaboratorToken(projectId, token);

            if (!project) {
                throw new ResponseError('CollaboratorTokenInvalid');
            }
            res.status(200).json({
                tokenValid: true,
                project
            });
        } catch(e) {
            logger.error('[checkCollaboratorToken] failed', { error: e, projectId: req?.params?.id, userId: req?.user?.id });

            if (e instanceof ResponseError) {
                res.status(e.status || 500).json({ message: e.message });
            } else {
                res.status(500).json({ message: 'Server error' });
            }
        }
    },
    acceptInvite: async (req: expressType.Request, res: expressType.Response): Promise<void> => {
        try {
            const user = req.user;
            const userEmail = user?.email;
            const projectId = req.params.id;
            const token = req?.query?.token?.toString();
            const userId = user?.id;

            if (!projectId || !user || !userId) {
                throw new ResponseError('NotFound');
            }

            if (!token) {
                throw new ResponseError('CollaboratorTokenNotProvided');
            }

            let project = await Project.findProjectByIdAndCollaboratorToken(projectId, token);
            if (!project) {
                throw new ResponseError('CollaboratorTokenInvalid');
            }

            const collaborators = project.collaborators;
            const invitedCollaborator = collaborators?.find(({ inviteToken }) => inviteToken === token);
            const role = invitedCollaborator?.role;

            if (!role) {
                logger.debug('Collaborator accepting invite without role', { userEmail, projectId: project.id });
            }

            // passing requiredAmount as 0 to exclude existing invited collaborator from counting
            if (!project.checkTierAllowanceForFeature('collaborators', { role, requiredAmount: 0 })) {
                throw new ResponseError('ProjectTierExceeded');
            }

            if (!project.ownerId) {
                throw new ResponseError('NotFound');
            }

            const owner = await User.findUserById(project.ownerId);

            if (userId === project?.ownerId.toString()) {
                const customError = {
                    status: 403,
                    name: 'CollaboratorIsOwner',
                    message: 'You are already the owner of this project',
                    project: {
                        id: project.id,
                        name: project.name,
                        cmsId: project?.wizard?.cms?.id,
                        cmsTitle: project?.wizard?.cms?.title,
                        ownerEmail: owner?.email,
                        siteUrl: project.siteUrl
                    }
                };
                res.status(403).json(customError);
                return;
            }

            if (!project) {
                throw new ResponseError('NotFound');
            }

            project = await Project.updateCollaboratorByTokenAndUserId(project, token, userId);
            const projectResponse = {
                id: projectId,
                name: project?.name,
                cmsId: project?.wizard?.cms?.id,
                cmsTitle: project?.wizard?.cms?.title,
                ownerEmail: owner?.email,
                siteUrl: project?.siteUrl,
                role
            };
            res.status(200).json(projectResponse);
            analytics.track(
                'Collaborators Invite Accepted (Owner)',
                {
                    projectId: projectId,
                    userId: owner?.id,
                    inviteeUserId: userId,
                    collaboratorRole: role
                },
                owner
            );
        } catch (e) {
            logger.error('[acceptInvite] failed', { error: e, projectId: req?.params?.id, userId: req?.user?.id });

            if (e instanceof ResponseError) {
                res.status(e.status || 500).json({ status: e.status, name: e.name, message: e.message });
            } else {
                res.status(500).json({ message: 'Server error' });
            }
        }
    }
};
