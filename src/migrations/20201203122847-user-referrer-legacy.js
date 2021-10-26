const User = require('../models/user.model').default;

module.exports = {
    up(db) {
        return User.updateMany(
            {       // find
                'analytics.initial_referrer': { $exists: false },
                temporary: false,
                createdAt: {$lt: new Date('2020-11-18')}
            },
            {       // update
                $set: {
                    'analytics.initial_referrer': 'legacy',
                    'analytics.initial_referrer_landing': 'legacy',
                    'analytics.initial_traffic_source': 'Legacy'
                }
            }
        );
    },

    down(db) {
        return User.updateMany(
            {       // find
                'analytics.initial_referrer': 'legacy'
            },
            {       // remove
                $unset: {
                    'analytics.initial_referrer': 1,
                    'analytics.initial_referrer_landing': 1,
                    'analytics.initial_traffic_source': 1
                }
            }
        );
    }
};
