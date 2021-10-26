import crypto from 'crypto';
import mongoose, { Model, PassportLocalDocument, Schema, Types } from 'mongoose';
import passportLocalMongoose from 'passport-local-mongoose';
import logger from '../services/logger';
import { makeTypeSafeSchema } from './model-utils';
import { MongooseTimestamps } from '../type-utils';
import { IUserDoc } from './user.model';

export interface IEmailValidation {
    userId: Types.ObjectId;
    email: string;
    salt?: string;
    hash?: string;
    validationToken: string;
}

export interface IEmailValidationDoc extends IEmailValidation, PassportLocalDocument<Types.ObjectId>, MongooseTimestamps {
    id?: string;
}

export interface IEmailValidationModel extends Model<IEmailValidationDoc> {
    // statics
    createEmailValidation(user: IUserDoc, email: string, password: string): Promise<IEmailValidation>;
    generateNewValidationToken(user: IUserDoc): Promise<IEmailValidation | null>;
    deleteEmailValidationById(validationId: Types.ObjectId): Promise<void>;
    getValidationByToken(token: string): Promise<IEmailValidation | null>;
    getValidationByUserId(userId: Types.ObjectId): Promise<IEmailValidation | null>;
}

const EmailValidationSchema = makeTypeSafeSchema(new Schema<IEmailValidationDoc, IEmailValidationModel>({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    email: { type: String, required: true },
    salt: { type: String },
    hash: { type: String },
    validationToken: { type: String, required: true }
} as Record<keyof IEmailValidation, any>, { timestamps: true }));

EmailValidationSchema.statics.createEmailValidation = async function (user, email, password) {
    const data = {
        userId: user._id,
        email: email,
        validationToken: crypto.randomBytes(16).toString('hex')
    };
    const projection = {
        _id: 1,
        userId: 1,
        email: 1,
        validationToken: 1,
    }
    const validation = await EmailValidation.findOneAndUpdate({ email }, data, { upsert: true, new: true, projection });
    await validation.setPassword(password);
    await validation.save();
    const { id, userId, validationToken } = validation;
    const log = { emailValidationId: id, userId, email, validationToken };
    logger.debug(`[createEmailValidation] validationToken ${validationToken}`);
    logger.debug(`[createEmailValidation] emailvalidation created`, log);
    return validation;
};

EmailValidationSchema.statics.generateNewValidationToken = async function (user) {
    const data = {
        validationToken: crypto.randomBytes(16).toString('hex')
    };
    const validation = await EmailValidation.findOneAndUpdate({ userId: user.id }, data, { new: true });
    logger.debug(`[generateNewValidationToken] token updated ${validation?.validationToken}`);
    return validation;
};

EmailValidationSchema.statics.deleteEmailValidationById = async function (validationId) {
    logger.debug(`[deleteEmailValidationById] deleted emailvalidationId: ${validationId}`);
    await EmailValidation.deleteOne({ _id: validationId });
};

EmailValidationSchema.statics.getValidationByToken = async function (token) {
    return EmailValidation.findOne({ validationToken: token }, '+salt +hash');
};

EmailValidationSchema.statics.getValidationByUserId = async function (userId) {
    return EmailValidation.findOne({ userId });
};

EmailValidationSchema.index({ 'email': 1 }, { unique: true });
EmailValidationSchema.index({ 'validationToken': 1 }, { unique: true });
EmailValidationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

// https://github.com/saintedlama/passport-local-mongoose#options
const credentialsOptions = {
    usernameField: 'email',
    saltField: 'salt',
    hashField: 'hash',
    usernameLowerCase: true,
};

EmailValidationSchema.plugin(passportLocalMongoose, credentialsOptions);

const EmailValidation = mongoose.model('EmailValidation', EmailValidationSchema.unsafeSchema);
export default EmailValidation;
