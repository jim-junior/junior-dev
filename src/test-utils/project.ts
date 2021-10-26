import type { default as ProjectType, IProjectDoc } from '../models/project.model';
import { IUserDoc } from '../models/user.model';

let Project: typeof ProjectType;

export const projectTestConfig = require('../services/customer-tier-service/customer-tier-service.test-data').config; // tmp, need to work on test-data

export const loadProject = (): typeof ProjectType => {
    Project = require('../models/project.model').default;
    return Project;
};

export const createProject = (user: IUserDoc, projectData?: IProjectDoc): Promise<IProjectDoc> => {
    Project = Project || loadProject();
    return new Project({
        ownerId: user._id,
        ...(projectData ?? {}),
    }).save();
};
