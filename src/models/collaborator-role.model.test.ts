import CollaboratorRole from './collaborator-role.model';

const viewerRole = new CollaboratorRole(
    'viewer',
    false,
    {},
    ['BASIC_ACCESS'],
    []
);

const editorRole = new CollaboratorRole(
    'editor',
    false,
    {},
    ['EDIT_ACCESS'],
    [viewerRole]
);

const codeEditorRole = new CollaboratorRole(
    'editor',
    false,
    { defaultStudioMode: 'code' },
    ['EDIT_ACCESS'],
    [viewerRole]
);

describe('Collaborator Role Model', () => {
    beforeAll(() => {
        jest.resetModules();
    });

    test('isDefaultCollaboratorRole', () => {
        expect(CollaboratorRole.OWNER.isDefaultCollaboratorRole()).toBeFalsy();
        expect(editorRole.isDefaultCollaboratorRole()).toBeFalsy();
        expect(CollaboratorRole.ADMIN.isDefaultCollaboratorRole()).toBeTruthy();
    });

    test('isAuthorized', () => {
        expect(viewerRole.isAuthorized('BASIC_ACCESS')).toBeTruthy();
        expect(viewerRole.isAuthorized('EDIT_ACCESS')).toBeFalsy();
        expect(editorRole.isAuthorized('BASIC_ACCESS')).toBeTruthy();
        expect(editorRole.isAuthorized('EDIT_ACCESS')).toBeTruthy();
    });

    test('getSettings', () => {
        expect(editorRole.getSettings()).toStrictEqual({ defaultStudioMode: 'content' });
        expect(codeEditorRole.getSettings()).toStrictEqual({ defaultStudioMode: 'code' });
    });

    test('listPermissions', () => {
        expect(viewerRole.listPermissions()).toStrictEqual(['BASIC_ACCESS']);
    });
});
