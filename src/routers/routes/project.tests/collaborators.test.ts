import type * as mongooseType from 'mongoose';
import type * as expressType from 'express';
import * as httpType from 'http';
import request from 'supertest';
import MockStrategy from 'passport-mock-strategy';
import passport from 'passport';
import type * as SuperTest from 'supertest';
import getPort from 'get-port';
import { clearDatabase, closeDatabase } from '../../../test-utils/mongo';
import type { default as CollaboratorRoleType } from '../../../models/collaborator-role.model';
import type { IUser, IUserDoc, IUserModel } from '../../../models/user.model';
import { IProjectModel, IProjectDoc, ICollaborator } from '../../../models/project.model';
import { configData } from './config';
import { projectData } from './project-data';
import { loadUser } from '../../../test-utils/user';
import { loadProject } from '../../../test-utils/project';
import { loadCollaboratorsRole } from '../../../test-utils/collaboratorRole';
import { loadCommonRequireMock, mockServerModules, mockAllRouters, mockAllProjectRoutes } from '../../../test-utils/requireMock';

const MOCK_PROVIDER = 'mock';

const startServer = async ({ mongoose, provider }: { mongoose: typeof mongooseType; provider: string }) => {
    mockServerModules({ jest, mongoose, passport });
    const startServer = require('../../../server');
    const serverPort = await getPort();
    return startServer({ provider, serverPort });
};

type IDoneCb = (Error: unknown, user?: any) => void;
// user is any and no IUserDoc because MockStrategy expect different User type
const mockUserAuthRequest = (user: any) => {
    passport.serializeUser((user: any, done: IDoneCb) => {
        done(null, user.id);
    });
    passport.deserializeUser((id: string, done: IDoneCb) => {
        if (id === user.id) {
            done(null, user);
        } else {
            done(new Error(`No such user with id ${id}`));
        }
    });
    passport.use(
        new MockStrategy({
            name: MOCK_PROVIDER,
            user
        })
    );
};

describe('Collaborators', () => {
    const uuid = '1234567890';
    let app: expressType.Application;
    let server: httpType.Server;
    let mongoose: typeof mongooseType;
    let user: IUserDoc;
    let project: IProjectDoc;
    let User: IUserModel;
    let Project: IProjectModel;
    let agent: SuperTest.SuperTest<SuperTest.Test>;
    let projectId: mongooseType.Types.ObjectId;
    let CollaboratorRole: typeof CollaboratorRoleType;
    // not typed services
    let ScoreService: any;
    let analytics: any;

    beforeAll(async () => {
        jest.resetModules();

        loadCommonRequireMock(jest, configData);
        await mockAllRouters({ whitelistedRouters: ['project.router.js'], jest });
        await mockAllProjectRoutes({ whitelistedRoutes: ['collaborators.ts'], jest });

        mongoose = require('mongoose');
        const runner = await startServer({ mongoose, provider: MOCK_PROVIDER });
        server = runner.server;
        app = runner.app;
        // create agent
        // https://visionmedia.github.io/superagent/
        agent = request(app);

        jest.mock('../../../services/project-services/score-service', () => ({
            addScoreForAction: jest.fn()
        }));

        jest.mock('uuid/v4', () => () => uuid);
        analytics = require('../../../services/analytics/analytics');
        ScoreService = require('../../../services/project-services/score-service');

        User = loadUser();
        Project = loadProject();
        CollaboratorRole = loadCollaboratorsRole();
    });

    beforeEach(async () => {
        await clearDatabase(mongoose);

        user = await User.createUser({
            email: 'project@owner.com',
            roles: ['user']
        } as Partial<IUser>);

        mockUserAuthRequest(user);

        projectId = mongoose.Types.ObjectId();
    });

    afterAll(async () => {
        await closeDatabase(mongoose);
        server.close();
    });

    describe('get collaborators', () => {
        test('for unknown project', async () => {
            expect.hasAssertions();
            const response = await agent.get('/project/123/collaborator').expect('Content-Type', /json/);
            expect(response.status).toBe(404);
        });

        test('for project with no collaborators', async () => {
            expect.hasAssertions();
            await new Project({
                _id: projectId,
                ownerId: user._id,
                ...projectData
            }).save();

            const response = await agent.get(`/project/${projectId}/collaborator`).expect('Content-Type', /json/).expect(200);

            expect(response.body).toEqual([
                {
                    id: user.id,
                    email: user.email,
                    role: CollaboratorRole.OWNER.name,
                    userId: user.id
                }
            ]);
        });

        test('for project with collaborators', async () => {
            expect.hasAssertions();
            const invitedCollaborator = await User.createUser({
                email: 'invited@collaborator.com',
                roles: ['user']
            } as Partial<IUser>);

            const viewerCollaborator = await User.createUser({
                email: 'viewer@collaborator.com',
                roles: ['user']
            } as Partial<IUser>);

            project = await new Project({
                _id: projectId,
                ownerId: user._id,
                collaborators: [
                    {
                        inviteEmail: invitedCollaborator.email,
                        role: CollaboratorRole.INVITED.name
                    },
                    {
                        userId: viewerCollaborator._id,
                        role: CollaboratorRole.VIEWER.name
                    }
                ],
                ...projectData
            }).save();

            const response = await agent.get(`/project/${projectId}/collaborator`).expect('Content-Type', /json/).expect(200);
            const expected = [
                {
                    id: user.id,
                    email: user.email,
                    role: CollaboratorRole.OWNER.name,
                    userId: user.id
                },
                {
                    id: expect.anything(),
                    email: invitedCollaborator.email,
                    userId: '',
                    role: CollaboratorRole.INVITED.name,
                    invitationRole: CollaboratorRole.INVITED.name
                },
                {
                    id: expect.anything(),
                    userId: viewerCollaborator.id,
                    email: viewerCollaborator.email,
                    role: CollaboratorRole.VIEWER.name
                }
            ];

            expect(response.body).toEqual(expected);
        });
    });

    describe('invite collaborators', () => {
        let inviteCollaborator: (
            projectId: string | mongooseType.Types.ObjectId,
            data: { email?: string; role?: string }
        ) => SuperTest.Test;

        const viewerInviteData = {
            email: 'test@stackbit.com',
            role: 'viewer'
        };

        beforeEach(async () => {
            project = await new Project({
                _id: projectId,
                ownerId: user._id,
                ...projectData
            }).save();

            inviteCollaborator = (projectId, data) => {
                return agent.post(`/project/${projectId}/invite-collaborator`).send(data);
            };
        });

        test('with invalid email', async () => {
            expect.hasAssertions();
            const invalidEmails = ['', 'email.com'];

            await Promise.all(
                invalidEmails.map(async (email) => {
                    const data = await inviteCollaborator(projectId, { email });
                    expect(data.body.message).toBe(`Email ${email} is not valid`);
                })
            );

            await inviteCollaborator(projectId, { email: '' }).expect('Content-Type', /json/).expect(422);
        });

        test('with invalid role', async () => {
            expect.hasAssertions();
            const inviteData = {
                email: 'test@stackbit.com',
                role: ''
            };
            const response = await inviteCollaborator(projectId, inviteData).expect('Content-Type', /json/);
            expect(response.status).toBe(500);
        });

        describe('by user', () => {
            let anotherUser: IUserDoc;
            beforeEach(async () => {
                projectId = mongoose.Types.ObjectId();

                anotherUser = await User.createUser({
                    email: 'another@user.com',
                    roles: ['user']
                } as Partial<IUser>);

                mockUserAuthRequest(anotherUser);
            });

            test('not associated with project', async () => {
                expect.hasAssertions();
                const response = await inviteCollaborator(projectId, viewerInviteData).expect('Content-Type', /json/).expect(404);
                expect(response.statusCode).toBe(404);
            });

            test('with no permissions to invite', async () => {
                expect.hasAssertions();
                project = await new Project({
                    _id: projectId,
                    ownerId: user._id,
                    collaborators: [
                        {
                            userId: anotherUser._id,
                            role: CollaboratorRole.VIEWER.name
                        }
                    ],
                    ...projectData
                }).save();

                const response = await inviteCollaborator(projectId, viewerInviteData).expect('Content-Type', /json/);

                expect(response.statusCode).toBe(404);
            });

            test('with permissions to invite', async () => {
                expect.hasAssertions();
                project = await new Project({
                    _id: projectId,
                    ownerId: user._id,
                    collaborators: [
                        {
                            userId: anotherUser._id,
                            role: CollaboratorRole.ADMIN.name
                        }
                    ],
                    ...projectData
                }).save();
                const addInvitedCollaboratorSpyOn = jest
                    .spyOn(Project, 'addInvitedCollaborator')
                    .mockImplementation((): any => Promise.resolve(project));

                const response = await inviteCollaborator(projectId, viewerInviteData).expect('Content-Type', /json/);

                expect(response.statusCode).toBe(200);

                expect(Project.addInvitedCollaborator).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        _id: expect.any(mongoose.Types.ObjectId),
                        ownerId: expect.any(mongoose.Types.ObjectId)
                    }),
                    expect.objectContaining({
                        _id: expect.any(mongoose.Types.ObjectId)
                    }),
                    { inviteToken: uuid, inviteEmail: viewerInviteData.email, role: viewerInviteData.role }
                );

                expect(analytics.track).toHaveBeenLastCalledWith(
                    'Collaborators Invite Collaborator',
                    {
                        projectId: project.id,
                        userId: anotherUser.id,
                        collaboratorRole: viewerInviteData.role
                    },
                    anotherUser
                );

                expect(ScoreService.addScoreForAction).toHaveBeenLastCalledWith('collaboratorInvite', project.id);
                addInvitedCollaboratorSpyOn.mockRestore();
            });
        });

        test('with exceeded tier', async () => {
            expect.hasAssertions();
            const projectId = mongoose.Types.ObjectId();
            const viewerCollaborators = [];

            for (let i = 0; i < 100; i++) {
                viewerCollaborators.push({
                    userId: mongoose.Types.ObjectId(),
                    role: CollaboratorRole.VIEWER.name
                });
            }
            await new Project({
                _id: projectId,
                ownerId: user._id,
                collaborators: viewerCollaborators,
                ...projectData
            }).save();

            const response = await inviteCollaborator(projectId, viewerInviteData).expect('Content-Type', /json/);
            expect(response.statusCode).toBe(402);
        });
    });

    describe('accept invite', () => {
        let invitedCollaborator: IUserDoc;

        beforeAll(async () => {
            invitedCollaborator = await User.createUser({
                email: 'invited@collaborator.com',
                roles: ['user']
            } as Partial<IUser>);
        });

        beforeEach(async () => {
            project = await new Project({
                _id: projectId,
                ownerId: user._id,
                collaborators: [
                    {
                        inviteToken: uuid,
                        inviteEmail: invitedCollaborator.email,
                        role: CollaboratorRole.VIEWER.name
                    },
                    {
                        userId: mongoose.Types.ObjectId(),
                        role: CollaboratorRole.VIEWER.name
                    }
                ],
                ...projectData
            }).save();

            mockUserAuthRequest(invitedCollaborator);
        });

        test('with invalid token', async () => {
            expect.hasAssertions();
            // accept invite to make token invalid in second request
            await agent.post(`/project/${projectId}/accept-collaboration-invite?token=${uuid}`);

            const tokens = [null, 'invalidToken', uuid];
            const [noTokenRes, invalidTokenRes, reusedToken] = await Promise.all(
                tokens.map(async (token) => {
                    return agent.post(`/project/${projectId}/accept-collaboration-invite?${token && `token=${token}`}`);
                })
            );

            expect(noTokenRes?.body.name).toBe('CollaboratorTokenNotProvided');
            expect(noTokenRes?.status).toBe(403);

            expect(invalidTokenRes?.body.name).toBe('CollaboratorTokenInvalid');
            expect(invalidTokenRes?.status).toBe(403);

            expect(reusedToken?.body.name).toBe('CollaboratorTokenInvalid');
            expect(reusedToken?.status).toBe(403);
        });

        test('with exceeded tier', async () => {
            expect.hasAssertions();
            projectId = mongoose.Types.ObjectId();
            project = await new Project({
                _id: projectId,
                ownerId: user._id,
                collaborators: [
                    {
                        userId: mongoose.Types.ObjectId(),
                        role: CollaboratorRole.VIEWER.name
                    },
                    {
                        userId: mongoose.Types.ObjectId(),
                        role: CollaboratorRole.VIEWER.name
                    },
                    {
                        inviteToken: uuid,
                        inviteEmail: invitedCollaborator.email,
                        role: CollaboratorRole.VIEWER.name
                    }
                ],
                ...projectData
            }).save();

            const response = await agent.post(`/project/${projectId}/accept-collaboration-invite?token=${uuid}`).expect(402);
            expect(response.body.name).toBe('ProjectTierExceeded');
        });

        test('by owner', async () => {
            expect.hasAssertions();
            projectId = mongoose.Types.ObjectId();
            mockUserAuthRequest(user);

            project = await new Project({
                _id: projectId,
                ownerId: user._id,
                collaborators: [
                    {
                        inviteToken: uuid,
                        inviteEmail: user.email,
                        role: CollaboratorRole.VIEWER.name
                    }
                ],
                ...projectData
            }).save();
            const response = await agent.post(`/project/${projectId}/accept-collaboration-invite?token=${uuid}`).expect(403);
            expect(response.body.name).toBe('CollaboratorIsOwner');
            expect(response.body.project).toEqual({
                id: project.id,
                name: project.name,
                cmsId: project?.wizard?.cms?.id,
                cmsTitle: project?.wizard?.cms?.title,
                ownerEmail: user.email,
                siteUrl: project.siteUrl
            });
        });

        describe('by user', () => {
            let collaborators: ICollaborator[];
            const spyOnProjectMethod = (methodName: typeof Project.prototype) =>
                jest.spyOn(Project, methodName).mockImplementation(jest.fn(() => Promise.resolve(project)));
            let updateCollaboratorByTokenAndUserIdSpyOn: ReturnType<typeof spyOnProjectMethod>;

            beforeAll(() => {
                collaborators = [
                    {
                        inviteToken: uuid,
                        inviteEmail: invitedCollaborator.email,
                        role: CollaboratorRole.VIEWER.name,
                        notifications: []
                    }
                ];
            });

            beforeEach(async () => {
                projectId = mongoose.Types.ObjectId();

                project = await new Project({
                    _id: projectId,
                    ownerId: user._id,
                    collaborators,
                    ...projectData
                }).save();

                updateCollaboratorByTokenAndUserIdSpyOn = spyOnProjectMethod('updateCollaboratorByTokenAndUserId');
            });

            afterEach(() => {
                updateCollaboratorByTokenAndUserIdSpyOn.mockRestore();
            });

            test('with different email then it was invited', async () => {
                expect.hasAssertions();
                const invitedCollaboratorWithDifferentEmail = await User.createUser({
                    email: 'invited-collaborator@different.email',
                    roles: ['user']
                } as Partial<IUser>);
                mockUserAuthRequest(invitedCollaboratorWithDifferentEmail);

                const response = await agent.post(`/project/${projectId}/accept-collaboration-invite?token=${uuid}`).expect(200);

                expect(Project.updateCollaboratorByTokenAndUserId).toHaveBeenCalledWith(
                    expect.objectContaining({
                        id: project.id,
                        collaborators: expect.arrayContaining([
                            // don't compare all object because of complexity comparing mongo objects
                            expect.objectContaining({
                                inviteToken: uuid
                            })
                        ])
                    }),
                    uuid,
                    invitedCollaboratorWithDifferentEmail.id
                );

                expect(response.body).toEqual({
                    id: project.id,
                    name: project.name,
                    cmsId: project?.wizard?.cms?.id,
                    cmsTitle: project?.wizard?.cms?.title,
                    ownerEmail: user.email,
                    siteUrl: project.siteUrl,
                    role: CollaboratorRole.VIEWER.name
                });
            });

            test('with same email then it was invited', async () => {
                expect.hasAssertions();
                const response = await agent.post(`/project/${projectId}/accept-collaboration-invite?token=${uuid}`).expect(200);
                expect(response.status).toBe(200);
            });
        });
    });
});
