import { default as CollaboratorRoleType } from '../models/collaborator-role.model';

export const loadCollaboratorsRole = (): typeof CollaboratorRoleType => {
    return require('../models/collaborator-role.model').default;
};
