// user related testing helpers

import type { default as UserType, IUserDoc, IUser } from '../models/user.model';
import type * as mongooseType from 'mongoose';
let User: typeof UserType;

export const loadUser = (): typeof UserType => {
    User = require('../models/user.model').default;
    return User;
};

export const createUser = (data?: IUser): Promise<IUserDoc> => {
    return loadUser().createUser({
        email: 'user@user.com',
        roles: ['user'],
        ...(data ?? {}),
    } as Partial<IUser>);
};

export const fetchUser = async (id: mongooseType.Types.ObjectId): Promise<IUserDoc> => {
    return (await User.findOne({ _id: id }))!;
};
