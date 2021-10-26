import config from '../../config';
import { format } from 'date-fns';
import { APIClient, SendEmailRequest } from 'customerio-node/api';
import uuid from 'uuid/v4';
import logger from '../logger';
import { IProjectDoc } from '../../models/project.model';
import { IUserDoc } from '../../models/user.model';

const client = new APIClient(config.customer.appApiKey!);

async function genericSendEmail(messageId: number, user: IUserDoc, data: Record<string, any>, toEmail?: string ) {
    const userEmail = user.email;
    const userId = user.id;

    if (userEmail && userId) {
        return client.sendEmail(
            new SendEmailRequest({
                to: toEmail || userEmail,
                transactional_message_id: messageId,
                identifiers: {
                    id: userId
                },
                message_data: data
            })
        );
    } else {
        logger.warn('Not sending Customer.io transactional email to user without email and user ID', { userId, userEmail, messageId });
    }
}

async function genericSendAnonymousEmail(messageId: number, email: string, data: Record<string, any>) {
    const userId = `anon-${uuid()}`;

    if (email) {
        return client.sendEmail(
            new SendEmailRequest({
                to: email,
                transactional_message_id: messageId,
                identifiers: {
                    id: userId
                },
                message_data: data
            })
        );
    } else {
        logger.warn('Not sending Customer.io transactional email to user without email', { messageId });
    }
}

export interface RequestedPublishEmail {
    projectName: string;
    requesterEmail: string;
    requestText: string;
    projectUrl: string;
}

export async function requestPublishEmail(user: IUserDoc, data: RequestedPublishEmail) {
    return genericSendEmail(config.customer.transactionalMessages.requestPublish, user, data);
}

export interface RequestedPublishDoneEmail {
    projectName: string;
    publisherEmail: string;
    projectUrl: string;
    siteUrl: string;
}

export async function requestedPublishDoneEmail(user: IUserDoc, data: RequestedPublishDoneEmail) {
    return genericSendEmail(config.customer.transactionalMessages.requestedPublishDone, user, data);
}

export interface PublishNotificationForViewers {
    projectName: string;
    projectUrl: string;
    siteUrl: string;
}

export async function publishNotificationForViewers(user: IUserDoc, data: PublishNotificationForViewers) {
    return genericSendEmail(config.customer.transactionalMessages.publishNotificationForViewers, user, data);
}

export interface InviteCollaboratorEmail {
    projectName: string;
    inviterEmail: string;
    inviteUrl: string;
    collaboratorRole: string;
}

export async function inviteCollaboratorEmail(email: string, data: InviteCollaboratorEmail) {
    return genericSendAnonymousEmail(config.customer.transactionalMessages.inviteCollaborator, email, data);
}

export const PLANS_EMAIL_EVENT = {
    STARTED: 'started',
    CANCELLED: 'cancelled',
    EXPIRED: 'expired'
} as const;

export type PlansEmailEvent = typeof PLANS_EMAIL_EVENT[keyof typeof PLANS_EMAIL_EVENT];

export async function sendPlansEmail(project: IProjectDoc, tierId: string, event: PlansEmailEvent) {
    const User = require('../../models/user.model').default;
    const user = await User.findUserById(project.ownerId);
    const transactionalMessageId = (config.customer.transactionalMessages.plans as Record<string, Partial<Record<PlansEmailEvent, number>>>)[tierId]?.[event];
    if (transactionalMessageId) {
        return genericSendEmail(transactionalMessageId, user, {
            projectName: project.name,
            studioUrl: `${config.server.clientOrigin}/studio/${project.id}/`,
            expiryDate: project.subscription.endOfBillingCycle ? format(project.subscription.endOfBillingCycle, 'MMMM do, yyyy') : ''
        });
    }
}

export interface SendImportEnquiry {
    text: string;
    email: string;
}

export async function sendImportEnquiryEmail(user: IUserDoc, data: SendImportEnquiry) {
    return genericSendEmail(config.customer.transactionalMessages.importEnquiry, user, data, 'support@stackbit.com');
}

export interface ContactFormEmail {
    projectName: string;
    name: string;
    email: string;
    subject: string;
    message: string;
}

export async function sendContactFormEmail(email: string, data: ContactFormEmail) {
    return genericSendAnonymousEmail(config.customer.transactionalMessages.contactForm, email, data);
}
