import express from 'express';
import { isLoggedIn, hasOrganizationAccess } from './router.utils';
import {
    getProjectList,
    getOrganization,
    getOrganizationList,
    updateOrganization,
    createOrganization,
    deleteOrganization,
    getOrganizationUserList,
    getOrganizationMemberships,
    addUserToOrganization,
    removeUserFromOrganization,
    removeUserFromOrganizationTeam,
    addUserToOrganizationTeam,
    createOrganizationTeam,
    updateOrganizationTeam,
    deleteOrganizationTeam,
    createProjectGroup,
    updateProjectGroup,
    removeProjectGroup,
    getProjectGroups,
    getRegisteredThemes,
    createRegisteredTheme,
    updateRegisteredTheme,
    removeRegisteredTheme
} from './routes/organization.routes';

const router = express.Router();

router.get('/list', isLoggedIn, getOrganizationList);
router.get('/:id', isLoggedIn, hasOrganizationAccess, getOrganization);
router.post('/', isLoggedIn, createOrganization);
router.patch('/:id', isLoggedIn, hasOrganizationAccess, updateOrganization);
router.delete('/:id', isLoggedIn, hasOrganizationAccess, deleteOrganization);

router.get('/:id/projects', isLoggedIn, hasOrganizationAccess, getProjectList);

router.get('/:id/user/list', isLoggedIn, hasOrganizationAccess, getOrganizationUserList);
router.put('/:id/user/:userId/', isLoggedIn, hasOrganizationAccess, addUserToOrganization);
router.delete('/:id/user/:userId/', isLoggedIn, hasOrganizationAccess, removeUserFromOrganization);

router.get('/:id/team/list', isLoggedIn, hasOrganizationAccess, getOrganizationMemberships);
router.post('/:id/team/', isLoggedIn, hasOrganizationAccess, createOrganizationTeam);
router.put('/:id/team/:teamId/user/:userId/', isLoggedIn, hasOrganizationAccess, addUserToOrganizationTeam);
router.delete('/:id/team/:teamId/user/:userId/', isLoggedIn, hasOrganizationAccess, removeUserFromOrganizationTeam);
router.patch('/:id/team/:teamId', isLoggedIn, hasOrganizationAccess, updateOrganizationTeam);
router.delete('/:id/team/:teamId', isLoggedIn, hasOrganizationAccess, deleteOrganizationTeam);

router.get('/:id/projectgroups', isLoggedIn, hasOrganizationAccess, getProjectGroups);
router.post('/:id/projectgroup', isLoggedIn, hasOrganizationAccess, createProjectGroup);
router.patch('/:id/projectgroup/:projectGroupId', isLoggedIn, hasOrganizationAccess, updateProjectGroup);
router.delete('/:id/projectgroup/:projectGroupId', isLoggedIn, hasOrganizationAccess, removeProjectGroup);

router.get('/:id/registered-themes', isLoggedIn, hasOrganizationAccess, getRegisteredThemes);
router.post('/:id/registered-themes', isLoggedIn, hasOrganizationAccess, createRegisteredTheme);
router.patch('/:id/registered-themes/:registeredThemeId', isLoggedIn, hasOrganizationAccess, updateRegisteredTheme);
router.delete('/:id/registered-themes/:registeredThemeId', isLoggedIn, hasOrganizationAccess, removeRegisteredTheme);

module.exports = router;
