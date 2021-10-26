import mongoose, { Document, Model, Schema, Types } from 'mongoose';
import { makeTypeSafeSchema } from './model-utils';

export interface ILock {
    name?: string;
}

export interface ILockDoc extends ILock, Document<Types.ObjectId> {
    id?: string;
}

export interface ILockModel extends Model<ILockDoc> {
    // statics
    acquire(lockName: string): Promise<boolean>;
    release(lockName: string): Promise<void>;
}

const LockSchema = makeTypeSafeSchema(new Schema<ILockDoc, ILockModel>({
    name: String,
} as Record<keyof ILock, any>));

LockSchema.index({ name: 1 }, { unique: true });

LockSchema.statics.acquire = async function (lockName) {
    const res = await Lock.updateOne(
        { name: lockName },
        { name: lockName },
        { upsert: true }
    );
    return res?.upserted?.length === 1;
};

LockSchema.statics.release = async function (lockName) {
    await Lock.remove({ name: lockName });
};

const Lock = mongoose.model('Lock', LockSchema.unsafeSchema);
export default Lock;
