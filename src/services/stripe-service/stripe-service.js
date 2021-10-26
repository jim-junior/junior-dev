const _ = require('lodash');
const config = require('../../config').default;
const customerTierService = require('../customer-tier-service/customer-tier-service');
const Project = require('../../models/project.model').default;
const User = require('../../models/user.model').default;
const CollaboratorRole = require('../../models/collaborator-role.model').default;
const analytics = require('../analytics/analytics');
const logger = require('../../services/logger');
const stripe = require('stripe')(config.stripe.secretKey);

async function cancelSubscription({ project }) {
    const subscriptionId = _.get(project, 'subscription.id');

    if (!subscriptionId) {
        throw new Error('Project does not have an associated subscription');
    }

    await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true
    });

    return Project.cancelSubscription(project.id, { skipEmail: true });
}

async function createCheckoutSessionForChangingPaymentMethod({
    cancelUrl,
    project,
    successUrl,
    user
}) {
    const subscriptionId = _.get(project, 'subscription.id');

    if (!subscriptionId) {
        throw new Error('Project does not have an associated subscription');
    }

    const checkoutData = {
        payment_method_types: ['card'],
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer: user.stripeCustomerId,
        mode: 'setup',
        setup_intent_data: {
            metadata: {
                customer_id: user.stripeCustomerId,
                subscription_id: subscriptionId
            }
        }
    };

    return stripe.checkout.sessions.create(checkoutData);
}

async function createCheckoutSessionForNewSubscription({
    cancelUrl,
    forceNewCustomer,
    planId,
    project,
    successUrl,
    tierId,
    user
}) {
    const tier = customerTierService.getById(tierId);

    if (!tier) {
        throw new Error('Invalid tier ID');
    }

    const stripePriceId = planId ? `price_${planId}` : _.get(config, ['customerTiers', tierId, 'defaultPlan']);
    const checkoutData = {
        payment_method_types: ['card'],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: project.id,
        subscription_data: {
            metadata: {
                projectId: project.id
            }
        },
        line_items: [{ price: stripePriceId, quantity: 1 }],
        mode: 'subscription',
        allow_promotion_codes: true,
        billing_address_collection: 'required'
    };

    if (user) {
        // If there isn't a Stripe customer ID associated with the user,
        // we create one.
        if (forceNewCustomer || !user.stripeCustomerId) {
            const stripeCustomer = await stripe.customers.create({
                email: user.email,
                metadata: {
                    userId: user.id
                }
            });
            await user.setStripeCustomerId(stripeCustomer.id);
        }
        checkoutData.customer = user.stripeCustomerId;
    }

    return stripe.checkout.sessions.create(checkoutData);
}

function createEventFromWebhook({ requestBody, signature }) {
    const signingSecret = process.env.STRIPE_WEBHOOK_SECRET || config.stripe.webhookSigningSecret;
    return stripe.webhooks.constructEvent(requestBody, signature, signingSecret);
}

async function getSubscription(project) {
    const subscriptionId = _.get(project, 'subscription.id');

    if (!subscriptionId) {
        return null;
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const productId = _.get(subscription, 'plan.product');
    const tier = customerTierService.getTierByProductId(productId);
    const data = {
        tier,
        startDate: subscription.created * 1000,
        paymentMethod: null
    };

    if (subscription.cancel_at) {
        data.scheduledForCancellation = true;
        data.cancelAt = subscription.cancel_at * 1000;
        data.canceledAt = subscription.canceled_at * 1000;
    }

    if (subscription.default_payment_method) {
        const paymentMethod = await stripe.paymentMethods.retrieve(subscription.default_payment_method);

        data.paymentMethod = {
            type: paymentMethod.type,
            card: {
                brand: _.get(paymentMethod, 'card.brand'),
                last4: _.get(paymentMethod, 'card.last4')
            }
        };
    }

    return data;
}

async function syncWithStripe(project) {
    const subscriptionId = project.subscription.id;
    if (!subscriptionId) {
        return project;
    }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return Project.updateSubscription(project, {
        endOfBillingCycle: new Date(subscription.current_period_end * 1000),
        scheduledForCancellation: !!subscription.cancel_at,
        tierId: customerTierService.getTierByProductId(subscription.items?.data?.[0]?.price?.product)?.id
    });
}

// (!) Ensure the Stripe webhook is dispatching the following events:
//
// - customer.subscription.created
// - checkout.session.completed
// - customer.subscription.deleted
// - customer.subscription.updated
// - invoice.paid
async function handleWebhookEvent({body, headers}) {
    let event;

    try {
        event = createEventFromWebhook({
            requestBody: body,
            signature: headers['stripe-signature']
        });
    } catch (error) {
        throw new Error('Invalid webhook signature');
    }

    if (event.type === 'customer.subscription.created') {
        const projectId = _.get(event, 'data.object.metadata.projectId');
        const subscriptionId = _.get(event, 'data.object.id');
        const customerId = _.get(event, 'data.object.customer');

        if (!projectId || !subscriptionId) {
            throw new Error('Project ID or Subscription ID missing from the request');
        }

        return registerSubscription({ customerId, projectId, subscriptionId });
    }

    if (event.type === 'checkout.session.completed' && event.data.object.mode === 'setup') {
        const setupIntentId = _.get(event, 'data.object.setup_intent');

        return updatePaymentMethod({ setupIntentId });
    }

    if (event.type === 'customer.subscription.deleted') {
        const projectId = _.get(event, 'data.object.metadata.projectId');

        if (!projectId) {
            throw new Error('Project ID missing from the request');
        }

        return Project.cancelSubscription(projectId, { immediate: true });
    }

    if (event.type === 'customer.subscription.updated') {
        const ignoredSubscription = _.get(event, 'data.object.metadata.ignoredSubscription') === 'true';
        if (ignoredSubscription) {
            logger.info(`Ignoring Stripe webhook from ignored subscription ${_.get(event, 'data.object.id')}`);
            return;
        }
        const projectId = _.get(event, 'data.object.metadata.projectId');
        if (!projectId) {
            throw new Error('Project ID missing from the request');
        }
        const isCancelled = !_.get(event, 'data.previous_attributes.cancel_at') &&
            _.get(event, 'data.object.cancel_at');
        if (isCancelled) {
            return Project.cancelSubscription(projectId);
        }
        await syncWithStripe(await Project.findById(projectId));
        return;
    }

    if (event.type === 'invoice.paid') {
        const subscriptionId = _.get(event, 'data.object.subscription');

        if (!subscriptionId) {
            return;
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const projectId = _.get(subscription, 'metadata.projectId');
        const periodEnd = _.get(event, 'data.object.lines.data.0.period.end');

        return Project.updateSubscription(projectId, {
            endOfBillingCycle: new Date(periodEnd * 1000)
        });
    }
}

async function registerSubscription({ customerId, projectId, subscriptionId }) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const productId = _.get(subscription, 'items.data.0.plan.product');
    const tierId = Object.keys(config.customerTiers).find(tierId => {
        return config.customerTiers[tierId].stripeProductId === productId;
    });

    // non blocking request to send analytics in the background
    (async () => {
        try {
            const user = await User.findUserByCustomerId(customerId);
            const userType = (
                user && await Project.findProjectByIdAndUser(projectId, user, CollaboratorRole.Permission.BILLING)
            ) ? 'user' : 'other-user';
            analytics.track('Subscription Created', { projectId, tierId, userType }, user || { id: 'unknown' });
        } catch (e) {
            logger.error('Error preparing analytics data for created subscription', e);
        }
    })();

    return Project.startSubscription(projectId, {
        subscriptionId,
        tierId
    });
}

async function updatePaymentMethod({ setupIntentId }) {
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    const setupIntentPaymentMethodId = setupIntent.payment_method;
    const setupIntentSubscriptionId = _.get(setupIntent, 'metadata.subscription_id');

    if (!setupIntentPaymentMethodId || !setupIntentSubscriptionId) {
        throw new Error('Event is missing SetupIntent parameters');
    }

    return stripe.subscriptions.update(setupIntentSubscriptionId, {
        default_payment_method: setupIntentPaymentMethodId
    });
}

async function updateTier({ planId, project, tierId }) {
    const currentTierId = project.subscription.tierId;

    if (currentTierId === tierId && !project.subscription.scheduledForCancellation) {
        return project;
    }

    const currentTier = customerTierService.getById(currentTierId);
    const newTier = customerTierService.getById(tierId);

    if (!currentTier || !newTier) {
        throw new Error('Invalid customer tier');
    }

    const stripePriceId = planId ? `price_${planId}` : _.get(config, ['customerTiers', tierId, 'defaultPlan']);
    const subscriptionId = project.subscription.id;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false,
        items: [
            { id: subscription.items.data[0].id, price: stripePriceId }
        ]
    });
    await syncWithStripe(project);
}

module.exports = {
    cancelSubscription,
    createCheckoutSessionForChangingPaymentMethod,
    createCheckoutSessionForNewSubscription,
    createEventFromWebhook,
    getSubscription,
    handleWebhookEvent,
    registerSubscription,
    updatePaymentMethod,
    updateTier
};
