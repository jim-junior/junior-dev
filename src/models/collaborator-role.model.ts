// This could be mapped to a Mongo collection in the future.

export type Permission = keyof typeof CollaboratorRole.Permission;

export interface CollaboratorRoleSettings {
    defaultStudioMode: 'code' | 'content'
}

export default class CollaboratorRole {
    name: string;
    phantom: boolean;
    settings: Partial<CollaboratorRoleSettings>;
    permissions: Permission[];
    subsets: CollaboratorRole[];

    static defaultSettings: CollaboratorRoleSettings = {
        defaultStudioMode: 'content'
    };

    constructor(name: string, phantom: boolean, settings: Partial<CollaboratorRoleSettings>, permissions: Permission[], subsets: CollaboratorRole[]) {
        this.name = name;
        this.phantom = phantom;
        this.settings = settings;
        this.permissions = permissions;
        this.subsets = subsets;
    }

    isDefaultCollaboratorRole(): boolean {
        return this === CollaboratorRole.DEFAULT_COLLABORATOR_ROLE;
    }

    isAuthorized(permission: Permission): boolean {
        if (this.permissions.includes(permission)) {
            return true;
        }
        return this.subsets.some(subset => subset.isAuthorized(permission));
    }

    getSettings(): CollaboratorRoleSettings {
        const defaults = this.subsets.reduce((accDefaults, role) => ({
            ...accDefaults,
            ...role.getSettings()
        }), CollaboratorRole.defaultSettings);
        return {
            ...defaults,
            ...this.settings
        };
    }

    listPermissions(): Permission[] {
        return this.permissions.concat(
            this.subsets.map(subset => subset.listPermissions()).flat()
        ).filter((v, i, a) => a.indexOf(v) === i); // unique items in array
    }

    static listNonPhantomRoles(): CollaboratorRole[] {
        return CollaboratorRole.rolesList.filter(role => !role.phantom);
    }

    static fromName(name: string): CollaboratorRole | undefined {
        return CollaboratorRole.rolesList.find(role => role.name === name);
    }

    static listByPermission(permission: Permission): CollaboratorRole[] {
        return CollaboratorRole.rolesList.filter(role => role.isAuthorized(permission));
    }

    static isValidNonPhantomRole(name: string): boolean {
        return !!CollaboratorRole.listNonPhantomRoles().find(role => role.name === name);
    }

    static Permission = {
        LOCK_SCREEN: 'LOCK_SCREEN',
        BASIC_ACCESS: 'BASIC_ACCESS',
        COLLABORATOR: 'COLLABORATOR',
        EDIT_ACCESS: 'EDIT_ACCESS',
        GET_ASSETS: 'GET_ASSETS',
        MANAGE_COLLABORATORS: 'MANAGE_COLLABORATORS',
        PUBLISH_SITE: 'PUBLISH_SITE',
        MANAGE_SPLIT_TEST: 'MANAGE_SPLIT_TEST',
        FULL_ACCESS: 'FULL_ACCESS',
        BILLING: 'BILLING',
        STACKBIT_ADMIN_IMPERSONATE: 'STACKBIT_ADMIN_IMPERSONATE',
        STACKBIT_SUPPORT_ADMIN: 'STACKBIT_SUPPORT_ADMIN',
        ON_SITE_WIDGET: 'ON_SITE_WIDGET'
    } as const;

    static NONE = new CollaboratorRole('none', true, {}, [], []);
    static INVITED = new CollaboratorRole('invited', true, {}, [], []);
    static UNLICENSED = new CollaboratorRole('unlicensed', false, {}, [
        CollaboratorRole.Permission.BASIC_ACCESS,
        CollaboratorRole.Permission.COLLABORATOR,
        CollaboratorRole.Permission.LOCK_SCREEN
    ], []);
    static VIEWER = new CollaboratorRole('viewer', false, {}, [
        CollaboratorRole.Permission.BASIC_ACCESS,
        CollaboratorRole.Permission.COLLABORATOR,
        CollaboratorRole.Permission.ON_SITE_WIDGET
    ], []);
    static EDITOR = new CollaboratorRole('editor', false, {}, [
        CollaboratorRole.Permission.EDIT_ACCESS,
        CollaboratorRole.Permission.GET_ASSETS
    ], [CollaboratorRole.VIEWER]);
    static ADMIN = new CollaboratorRole('admin', false, {}, [
        CollaboratorRole.Permission.MANAGE_COLLABORATORS,
        CollaboratorRole.Permission.PUBLISH_SITE,
        CollaboratorRole.Permission.MANAGE_SPLIT_TEST,
        CollaboratorRole.Permission.BILLING
    ], [CollaboratorRole.EDITOR]);
    static DEVELOPER = new CollaboratorRole('developer', false, {
        defaultStudioMode: 'code'
    }, [], [CollaboratorRole.ADMIN]);
    static OWNER = new CollaboratorRole('owner', true, {}, [
        CollaboratorRole.Permission.FULL_ACCESS
    ], [CollaboratorRole.ADMIN]);
    static STACKBIT_ADMIN = new CollaboratorRole('stackbit_admin', true, {}, [
        CollaboratorRole.Permission.BASIC_ACCESS,
        CollaboratorRole.Permission.GET_ASSETS,
        CollaboratorRole.Permission.STACKBIT_ADMIN_IMPERSONATE,
        CollaboratorRole.Permission.ON_SITE_WIDGET
    ], []);
    static STACKBIT_SUPPORT_ADMIN = new CollaboratorRole('stackbit_support_admin', true, {}, [
        CollaboratorRole.Permission.STACKBIT_ADMIN_IMPERSONATE,
        CollaboratorRole.Permission.STACKBIT_SUPPORT_ADMIN
    ], [CollaboratorRole.STACKBIT_ADMIN, CollaboratorRole.OWNER]);

    static DEFAULT_COLLABORATOR_ROLE = CollaboratorRole.ADMIN;

    static rolesList = [
        CollaboratorRole.NONE,
        CollaboratorRole.INVITED,
        CollaboratorRole.UNLICENSED,
        CollaboratorRole.EDITOR,
        CollaboratorRole.DEVELOPER,
        CollaboratorRole.VIEWER,
        CollaboratorRole.ADMIN,
        CollaboratorRole.OWNER,
        CollaboratorRole.STACKBIT_ADMIN,
        CollaboratorRole.STACKBIT_SUPPORT_ADMIN
    ];
}
