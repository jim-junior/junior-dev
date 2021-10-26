import _  from 'lodash';
import User, { IUserDoc } from '../../models/user.model';
import MailgunService from '../mailgun-service/mailgun-service';
import ResponseErrors  from '../../routers/response-errors';
import { isDOExclusiveUser } from '../digitalocean-services/digitalocean-service';

function forgotPassword(email: string) {
    return User.findUserByEmail(email).then(user => {
        if (user) {
            if (_.get(user, 'authProviders.email')) {
                return user.createResetPasswordToken().then(resetPasswordToken => {
                    return {
                        user,
                        resetPasswordToken
                    };
                });
            } else {
                return Promise.reject(ResponseErrors.ResetPasswordForNonEmailUserError);
            }
        }

        return Promise.reject(ResponseErrors.ResetPasswordUserNotFound);
    }).then(({user, resetPasswordToken}) => {
        return MailgunService.forgotPasswordEmail(user, resetPasswordToken, email);
    });
}

function getTokenByConnectionType(user: IUserDoc, connectionType: string) {
    const userConnections = user.connections ?? [];
    return userConnections.find(({ type }) => type === connectionType )?.accessToken;
}

async function isValidPreferences(user: IUserDoc, preferences: IUserDoc['preferences']) {
    const isDOExclusive = preferences?.exclusivePlatforms?.find(({ type }) => type === 'digitalocean');

    if (isDOExclusive) {
        return await isDOExclusiveUser(user);
    }

    return true;
}

module.exports = {
    forgotPassword,
    getTokenByConnectionType,
    isValidPreferences
};
