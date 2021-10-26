import crypto from 'crypto';
import { isBefore } from 'date-fns';
import { ICollaboratorNotification, IProjectDoc } from '../../models/project.model';
import { SignJWT } from 'jose/jwt/sign';
import { jwtVerify } from 'jose/jwt/verify';
import mongoose from 'mongoose';
import config from '../../config';

export function duplicateProjectName(name: string, randomize?: boolean): string {
    const previousMatch = name.match(new RegExp(/ copy ([0-9]+)?$/));
    let copyNumber = '01';
    if (previousMatch && previousMatch[1]) {
        copyNumber = ('0' + (parseInt(previousMatch[1], 10) + 1)).slice(-2);
    }

    if (randomize) {
        copyNumber = crypto.randomBytes(4).toString('hex').substr(0,5);
    }
    return previousMatch && previousMatch[1] ? name.replace(new RegExp(`${previousMatch[1]}$`), copyNumber) : `${name} copy ${copyNumber}`;
}

export function alphanumericName(name: string): string {
    return name.toLowerCase().trim().replace(/[\s]/gi, '-')
        .replace(/[^0-9a-z-]/gi, '')
        .replace(/(-+)/gi, '-')
        .replace(/^(-+)/gi, '');
}

export function uniqueAlphanumericName(project: IProjectDoc, name: string): string {
    const id = project.id!.substr(3, 5);
    let projectName = alphanumericName(name ?? project.name);
    if (projectName.endsWith('-')) {
        projectName = projectName.slice(0, -1);
    }
    return `${projectName}-${id}`;
}

export function validateSiteName(name: string): boolean {
    return /^([a-z\d-_]+)$/i.test(name);
}

export function getProjectEnvironments(project: IProjectDoc): (string | null)[] {
    return ([null] as (string | null)[]).concat(Object.keys(project.environments ?? {}));
}

export function getDeploymentId(project: IProjectDoc): string | null {
    return project.wizard?.deployment?.id ?? null;
}

export function findCollaboratorNotificationByType(notifications: ICollaboratorNotification[], { deployedAt, notificationType }: { deployedAt?: Date, notificationType: string }): ICollaboratorNotification | undefined {
    return notifications.find(({ type, lastSentAt }) => {
        if (deployedAt && lastSentAt) {
            const pushedSinceLastSentNotification = isBefore(lastSentAt, deployedAt);
            return type === notificationType && pushedSinceLastSentNotification;
        }

        return type === notificationType;
    });
}

async function generateProjectIdToken(): Promise<string> {
    if (!config.project?.jwtSecret) {
        throw Error('No secret found');
    }
    const secret = config.project.jwtSecret;
    const secretKey = crypto.createSecretKey(Buffer.from(secret, 'hex'));
    const id = mongoose.Types.ObjectId();
    const idHexString = id.toHexString();
    return new SignJWT({ projectId: idHexString })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('24h')
        .sign(secretKey);
}

async function readProjectIdToken(token: string): Promise<string> {
    if (!config.project?.jwtSecret) {
        throw Error('No secret found');
    }
    const secret = config.project.jwtSecret;
    const secretKey = crypto.createSecretKey(Buffer.from(secret, 'hex'));
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
    return payload.projectId as string;
}

async function readJWTToken(token: string, secret: string): Promise<string> {
    const secretKey = crypto
        .createHash('sha256')
        .update(secret)
        .digest();
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
    return payload as any;
}

function isV2Supported(project: IProjectDoc): boolean {
    const source = project?.wizard?.theme?.settings?.source;
    const deploymentId = project?.wizard?.deployment?.id ?? '';
    return config.v2themes.includes(source) && config.v2deployments.includes(deploymentId);
}

export default {
    duplicateProjectName,
    alphanumericName,
    uniqueAlphanumericName,
    validateSiteName,
    getProjectEnvironments,
    getDeploymentId,
    findCollaboratorNotificationByType,
    generateProjectIdToken,
    readProjectIdToken,
    readJWTToken,
    isV2Supported
};
