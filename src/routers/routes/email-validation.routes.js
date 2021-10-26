const EmailValidation = require('../../models/email-validation.model').default;
const MailgunService = require('../../services/mailgun-service/mailgun-service');
const logger = require('../../services/logger');
const User = require('../../models/user.model').default;
const ResponseErrors = require('../../routers/response-errors');

module.exports = {
    resendValidationEmail: (req, res) => {
        const user = req.user;
        logger.debug(`[resendValidationEmail] request from userId ${user.id}`);
        return EmailValidation.generateNewValidationToken(user).then(async (validation) => {
            return MailgunService.sendValidationEmail(validation.email, validation.validationToken).then(() => {
                return res.status(200).json({'message': `email sent to ${validation.email}`});
            });
        }).catch(err => {
            return res.status(400).json(err);
        });
    },
    getMyEmailValidationTokens: async (req, res) => {
        const { user } = req;

        try {
            if (user.emailVerification === 'verified') {
                throw ResponseErrors.UserEmailAlreadyVerified;
            }

            const validation = await EmailValidation.findOne({ userId: user.id });
            if (!validation) {
                await user.setEmailVerificationStatus('expired');
                throw ResponseErrors.UserEmailValidationExpired;
            }

            return res.status(200).json({ email: validation.email });
        } catch (err) {
            return res.status(err.status || 500).json(err);
        }
    }
};
