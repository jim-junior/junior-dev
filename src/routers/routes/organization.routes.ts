import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import Organization, { IOrganization } from '../../models/organization.model';
import Project, { ProjectListFilterParams } from '../../models/project.model';
import logger from '../../services/logger';
import { SortedPagesParams, parseSortDirection } from '../../services/utils/sortedpages.utils';
import type { ITeam } from '../../models/organization.team.submodel';
import { ResponseError } from '../../services/utils/error.utils';
import { IProjectGroup } from '../../models/organization.project-group.submodel';
import { IRegisteredTheme } from '../../models/organization.registered-themes.submodel';

export async function getOrganizationList(req: Request, res: Response): Promise<void> {
    try {
        const organizations = await Organization.findOrganizations(req.user!);
        const organizationsJson = await Promise.all(
            organizations.map(async (organization) => {
                return await Organization.objectForListResponse(organization);
            })
        );
        res.json(organizationsJson);
    } catch (err: any) {
        logger.error('Organization: [getOrganizationList] Error Getting Organization List', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function getOrganization(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const organization = await Organization.getOrganization(organizationObjectId);
        if (!organization) {
            throw new ResponseError('NotFound');
        }
        const organizationsJson = await Organization.objectForResponse(organization);
        res.json(organizationsJson);
    } catch (err: any) {
        logger.error('Organization: [getOrganization] Error Getting Organization', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function createOrganization(req: Request, res: Response): Promise<void> {
    try {
        const { name } = req.body;
        const organization = await Organization.createOrganization({ name } as IOrganization);
        const organizationsJson = await Organization.objectForResponse(organization);
        res.json(organizationsJson);
    } catch (err: any) {
        logger.error('Organization: [create] Error Creating Organization', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function updateOrganization(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const { name } = req.body;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const organization = await Organization.updateOrganization(organizationObjectId, {
            name
        } as IOrganization);
        if (!organization) {
            throw new ResponseError('NotFound');
        }
        const organizationsJson = await Organization.objectForResponse(organization);
        res.json(organizationsJson);
    } catch (err: any) {
        logger.error('Organization: [update] Error Updating Organization', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function deleteOrganization(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        await Organization.deleteOrganization(organizationObjectId);
        res.status(200).json();
    } catch (err: any) {
        logger.error('Organization: [delete] Error Deleting Organization', { err });
        res.status(err.status || 500).json(err);
    }
}

export async function getProjectList(req: Request, res: Response): Promise<void> {
    try {
        const { id: organizationId } = req.params;
        const {
            namePart,
            themeId, // filtering
            sortByField,
            sortDirection, // sorting
            pageSize,
            lastPageLastItemVal, // last value of last row in last page. for scalable next page
            pageIndex // if lastSortVal doesn't exists, pagination page index number (zero based)
        } = req.query;

        const filterParams = {
            namePart,
            themeId
        } as ProjectListFilterParams;

        const sortedPagesParams = {
            sortByField: sortByField,
            sortDirection: parseSortDirection(sortDirection),
            pageSize: pageSize ? parseInt(pageSize as string) : undefined,
            lastPageLastItemVal: lastPageLastItemVal,
            pageIndex: pageIndex ? parseInt(pageIndex as string) : undefined
        } as SortedPagesParams;

        const projects = await Project.findProjectsForOrganization(
            mongoose.Types.ObjectId(organizationId),
            filterParams,
            sortedPagesParams
        );

        const response = await Promise.all(
            projects.map(async (project) => {
                return await Project.projectObjectForResponse(project, req.user!);
            })
        );
        res.json(response);
    } catch (err: any) {
        logger.error('Organization: [getProjectList] error getting organization projects', { err });
        res.status(err.status || 500).json(err);
    }
}

export async function getOrganizationUserList(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const organization = await Organization.getOrganization(organizationObjectId);
        if (!organization) {
            throw new ResponseError('NotFound');
        }

        const users = await organization.getUsers();
        res.json(
            await Promise.all(
                users.map(async (user) => {
                    return await Organization.userForListResponse(organizationObjectId, user);
                })
            )
        );
    } catch (err: any) {
        logger.error('Organization: [getOrganizationUserList] Error Fetching OrganizationUser List', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function getOrganizationMemberships(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const organization = await Organization.getOrganization(organizationObjectId);
        if (!organization) {
            throw new ResponseError('NotFound');
        }

        const teams = (await organization.getTeams()) ?? [];
        res.json(
            await Promise.all(
                teams.map(async (team) => {
                    return await Organization.teamForResponse(team);
                })
            )
        );
    } catch (err: any) {
        logger.error('Organization: [getOrganizationMemberships] Error Fetching OrganizationMemberships', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function addUserToOrganization(req: Request, res: Response): Promise<void> {
    try {
        const { id, userId } = req.params;

        const organizationObjectId = mongoose.Types.ObjectId(id);
        const userObjectId = mongoose.Types.ObjectId(userId);

        await Organization.addUser(organizationObjectId, userObjectId);
        res.status(200).json();
    } catch (err: any) {
        logger.error('Organization: [addUserToOrganization] Error adding user', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function removeUserFromOrganization(req: Request, res: Response): Promise<void> {
    try {
        const { id, userId } = req.params;

        const organizationObjectId = mongoose.Types.ObjectId(id);
        const userObjectId = mongoose.Types.ObjectId(userId);
        await Organization.removeUser(organizationObjectId, userObjectId);
        res.status(200).json();
    } catch (err: any) {
        logger.error('Organization: [removeUserFromOrganization] Error removing user', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function createOrganizationTeam(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const organization = await Organization.createTeam(organizationObjectId, req.body as Partial<ITeam>);
        if (!organization) {
            throw new ResponseError('NotFound');
        }
        const organizationsJson = await Organization.objectForResponse(organization!);
        res.json(organizationsJson);
    } catch (err: any) {
        logger.error('Organization: [createOrganizationTeam] Error Creating Organization Team', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function updateOrganizationTeam(req: Request, res: Response): Promise<void> {
    try {
        const { id, teamId } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const teamObjectId = mongoose.Types.ObjectId(teamId);
        const organization = await Organization.updateTeam(organizationObjectId, teamObjectId, req.body as Partial<ITeam>);
        if (!organization) {
            throw new ResponseError('NotFound');
        }
        const organizationsJson = await Organization.objectForResponse(organization);
        res.json(organizationsJson);
    } catch (err: any) {
        logger.error('Organization: [updateOrganizationTeam] Error Updating Team', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function deleteOrganizationTeam(req: Request, res: Response): Promise<void> {
    try {
        const { id, teamId } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const teamObjectId = mongoose.Types.ObjectId(teamId);
        await Organization.deleteTeam(organizationObjectId, teamObjectId);
        res.status(200).json();
    } catch (err: any) {
        logger.error('Organization: [deleteOrganizationTeam] Error Deleting Team', { err });
        res.status(err.status || 500).json(err);
    }
}

export async function addUserToOrganizationTeam(req: Request, res: Response): Promise<void> {
    try {
        const { id, teamId, userId } = req.params;

        const organizationObjectId = mongoose.Types.ObjectId(id);
        const teamObjectId = mongoose.Types.ObjectId(teamId);
        const userObjectId = mongoose.Types.ObjectId(userId);
        await Organization.addUserToTeam(organizationObjectId, teamObjectId, userObjectId);
        res.status(200).json();
    } catch (err: any) {
        logger.error('Organization: [addUserToOrganizationTeam] Error adding user to team', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function removeUserFromOrganizationTeam(req: Request, res: Response): Promise<void> {
    try {
        const { id, teamId, userId } = req.params;

        const organizationObjectId = mongoose.Types.ObjectId(id);
        const teamObjectId = mongoose.Types.ObjectId(teamId);
        const userObjectId = mongoose.Types.ObjectId(userId);
        await Organization.removeUserFromTeam(organizationObjectId, teamObjectId, userObjectId);
        res.status(200).json();
    } catch (err: any) {
        logger.error('Organization: [removeUserFromOrganizationTeam] Error removing user from team', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function getProjectGroups(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const organization = await Organization.getOrganization(organizationObjectId);
        if (!organization) {
            throw new ResponseError('NotFound');
        }

        const projectGroups = (await organization.getProjectGroups()) ?? [];
        const projectGroupsJSON = await Promise.all(
            projectGroups.map(async (prGroup) => {
                return await Organization.projectGroupForResponse(prGroup);
            })
        );
        res.json(projectGroupsJSON);
    } catch (err: any) {
        logger.error('Organization: [getProjectGroups] Error Fetching OrganizationProjectGroups', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function createProjectGroup(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const { name } = req.body;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const organization = await Organization.createProjectGroup(organizationObjectId, { name });
        if (organization === null) {
            throw new ResponseError('NotFound');
        }
        const organizationsJson = await Organization.objectForResponse(organization!);
        res.json(organizationsJson);
    } catch (err: any) {
        logger.error('Organization: [createProjectGroup] Error Creating Project Group', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function updateProjectGroup(req: Request, res: Response): Promise<void> {
    try {
        const { id, projectGroupId } = req.params;
        const { name } = req.body;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const projectGroupObjectId = mongoose.Types.ObjectId(projectGroupId);

        if (projectGroupId) {
            const organization = await Organization.updateProjectGroup(organizationObjectId, projectGroupObjectId, {
                name
            } as IProjectGroup);

            if (organization === null) {
                throw new ResponseError('NotFound');
            }

            const organizationsJson = await Organization.objectForResponse(organization);
            res.json(organizationsJson);
        } else {
            logger.error('[updateProjectGroup] no projectGroupId provided', { organizationId: id });
            throw new ResponseError('UnsupportedOperation');
        }
    } catch (err: any) {
        logger.error('Organization: [updateProjectGroup] Error Updating Project Group', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function removeProjectGroup(req: Request, res: Response): Promise<void> {
    try {
        const { id, projectGroupId } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const projectGroupObjectId = mongoose.Types.ObjectId(projectGroupId);

        if (projectGroupId) {
            await Organization.deleteProjectGroup(organizationObjectId, projectGroupObjectId);
            res.status(200).json();
        } else {
            logger.error('[removeProjectGroup] no projectGroupId provided', { organizationId: id });
            throw new ResponseError('UnsupportedOperation');
        }
    } catch (err: any) {
        logger.error('Organization: [removeProjectGroup] Error Deleting Project Group', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function getRegisteredThemes(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const organization = await Organization.getOrganization(organizationObjectId);
        if (!organization) {
            throw new ResponseError('NotFound');
        }

        const registeredThemes = (await organization.getRegisteredThemes()) ?? [];
        const registeredThemesJSON = await Promise.all(
            registeredThemes.map(async (registeredTheme) => {
                return await Organization.registeredThemeForResponse(registeredTheme);
            })
        );
        res.json(registeredThemesJSON);
    } catch (err: any) {
        logger.error('Organization: [getRegisteredThemes] Error Fetching OrganizationRegisteredThemes', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function createRegisteredTheme(req: Request, res: Response): Promise<void> {
    try {
        const { id } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const organization = await Organization.createRegisteredTheme(organizationObjectId, req.body as Partial<IRegisteredTheme>);
        if (organization === null) {
            throw new ResponseError('NotFound');
        }
        const organizationsJson = await Organization.objectForResponse(organization!);
        res.json(organizationsJson);
    } catch (err: any) {
        logger.error('Organization: [createRegisteredTheme] Error Creating Registered Theme', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function updateRegisteredTheme(req: Request, res: Response): Promise<void> {
    try {
        const { id, registeredThemeId } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const registeredThemeObjectId = mongoose.Types.ObjectId(registeredThemeId);

        if (registeredThemeId) {
            const organization = await Organization.updateRegisteredTheme(
                organizationObjectId,
                registeredThemeObjectId,
                req.body as Partial<IRegisteredTheme>
            );

            if (organization === null) {
                throw new ResponseError('NotFound');
            }

            const organizationsJson = await Organization.objectForResponse(organization);
            res.json(organizationsJson);
        } else {
            logger.error('[updateRegisteredTheme] no registeredThemeId provided', { organizationId: id });
            throw new ResponseError('UnsupportedOperation');
        }
    } catch (err: any) {
        logger.error('Organization: [updateRegisteredTheme] Error Updating Registered Theme', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}

export async function removeRegisteredTheme(req: Request, res: Response): Promise<void> {
    try {
        const { id, registeredThemeId } = req.params;
        const organizationObjectId = mongoose.Types.ObjectId(id);
        const registeredThemeObjectId = mongoose.Types.ObjectId(registeredThemeId);

        if (registeredThemeId) {
            await Organization.deleteRegisteredTheme(organizationObjectId, registeredThemeObjectId);
            res.status(200).json();
        } else {
            logger.error('[removeRegisteredTheme] no registeredThemeId provided', { organizationId: id });
            throw new ResponseError('UnsupportedOperation');
        }
    } catch (err: any) {
        logger.error('Organization: [removeRegisteredTheme] Error Deleting Registered Theme', { err: err?.message });
        res.status(err.status || 500).json(err);
    }
}
