import type { IUserDoc } from './models/user.model';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: IUserDoc;
        }
    }
}

export type Writeable<T> = { -readonly [P in keyof T]: T[P] };

export interface MongooseTimestamps {
    createdAt: Date;
    updatedAt: Date;
}

export type PromiseType<T> = T extends Promise<infer V> ? V : never;
