const axios = require('axios');
const Segment = require('analytics-node');
const CIO = require('customerio-node');
// const Crisp = require('node-crisp-api');

const async = require('async');
const _ = require('lodash');
const omitDeep = require('omit-deep-lodash');
const config = require('../../config').default;
const logger = require('../logger');
const { mapToObject } = require('../utils/code.utils');

let analyticsOptions = {};
if (['local', 'development'].indexOf(config.env) > -1) {
    analyticsOptions.flushAt = 1;
}
const analytics = new Segment(config.segment.writeKey, analyticsOptions);
// const CrispClient = new Crisp();
// if (config.crisp.enabled) {
//     CrispClient.authenticate(config.crisp.tokenId, config.crisp.tokenKey);
// }
module.exports = {
    identify: (user, req) => {
        if (_.get(user, 'authProviders.email.hash')) {
            throw 'Blocked reporting sensitive user data';
        }

        let userObj = filterUser(user);
        analytics.identify({
            userId: user.id,
            traits: {
                ...userObj,
                server: true
            }
        });
        // if (config.crisp.enabled) {
        //     CrispClient.websitePeople.updatePeopleProfile(config.crisp.websiteId, user.email, userObj);
        //
        // }
        logger.info('user identified', { user: userObj });

        if (req && req.cookies.ajs_anonymous_id) {
            analytics.alias({
                previousId: req.cookies.ajs_anonymous_id,
                userId: user.id
            });
            logger.info('user alias', { anonymousId: req.cookies.ajs_anonymous_id, userId: user.id });
        }
    },
    track: (name, props, user, loggerProps) => {
        if (_.get(user, 'authProviders.email.hash')) {
            throw 'Blocked reporting sensitive user data';
        }

        let userObj = filterUser(user);
        if (props.projectId && !props.tierId) {
        }
        analytics.track({
            event: name,
            userId: user.id,
            properties: { ...props },
            context: { traits: userObj, user_agent: 'server' }
        });
        // if (config.crisp.enabled) {
        //     CrispClient.websitePeople.addPeopleEvent(config.crisp.websiteId, user.email, {
        //         text: name,
        //         data: {...props}
        //     });
        // }
        if (JSON.stringify(props).length > 1000) {
            logger.warn('Analytics props object too long!', { props: props });
        }
        logger.info(`[Analytics] ${name}`, {
            ...props,
            ...loggerProps,
            context: { traits: userObj }
        });
    },
    anonymousTrack: (name, props, anonymousId) => {
        if (anonymousId) {
            analytics.track({
                event: name,
                anonymousId: anonymousId,
                properties: { ...props },
                context: { user_agent: 'server' }
            });
        }

        logger.info(`[Analytics] ${name}`, {
            ...props,
            anonymous: true
        });
    },
    deleteAndSuppressUser: (userId, type = 'Delete') => {
        // Types: [Suppress_With_Delete, Delete, Unsuppress, Suppress, Delete_Internal]
        const values = Array.isArray(userId) ? userId : [userId];
        logger.debug('[Analytics] DeleteAndSuppressUser', { userIds: values, type });
        return axios
            .post(
                `https://platform.segmentapis.com/v1beta/workspaces/${config.segment.workspace}/regulations`,
                {
                    regulation_type: type,
                    attributes: {
                        name: 'userId',
                        values: values
                    }
                },
                {
                    headers: {
                        Authorization: `Bearer ${config.segment.deleteToken}`
                    }
                }
            )
            .catch(err => {
                logger.error('[Analytics] Failed to delete user from segment.io');
            })
            .then(() => {
                const cio = new CIO(config.customer.siteId, config.customer.apiKey);
                return async.eachLimit(values, 10, (value, callback) => {
                    return cio.destroy(value).finally(callback);
                });
            })
            .catch(err => {
                logger.error('[Analytics] Failed to delete user from customer.io');
            });
    },
    alias: props => {
        analytics.alias(props);
    },
    flush: () => {
        return new Promise((resolve, reject) => {
            analytics.flush((err, batch) => {
                resolve();
            });
        });
    },
    projectIdFromRequest(req) {
        function escapeRegExp(str) {
            return str ? str.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1') : '';
        }

        // Replace utility function
        function replaceAll(str, find, replace) {
            return str ? str.replace(new RegExp(escapeRegExp(find), 'g'), replace) : '';
        }

        let path = replaceAll(req.get('referer'), req.get('origin'), '');
        let match = path.split('/');
        if (match && match[1] === 'edit') {
            return match[2];
        }

        return null;
    }
};

function filterUser(user) {
    let userObj = user;
    if (userObj.toObject) {
        userObj = user.toObject();
        userObj._id = user._id.toString();
        userObj.tosVersion = mapToObject(user.tosVersion);
    }
    return omitDeep(userObj, 'accessToken', 'refreshToken', 'hash', 'salt');
}
