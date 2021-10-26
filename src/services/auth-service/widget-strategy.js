const AuthTokenStrategy = require('passport-auth-token');
const _ = require('lodash');
const User = require('../../models/user.model').default;
const ResponseError = require('../../routers/response-errors');

module.exports = new AuthTokenStrategy(
    {
        headerFields: ['authorization']
    },
    function (token, done) {
        token = _.last(token.split(' '));
        User.findUserByWidgetAuthToken(token).then(user => {
            if (!user) {
                return done(ResponseError.NotFound);
            }
            done(null, user);
        });
    }
);
