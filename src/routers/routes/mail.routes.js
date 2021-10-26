const validator = require('validator');
const { sendImportEnquiryEmail } = require('../../services/customerio-service/customerio-transactional-service');

module.exports = {
    sendImportEnquiry: async (req, res) => {
        const user = req.user;
        const { fields } = req.body;

        const data = {
            email: validator.isEmail(fields.email) ? fields.email : '',
            text: validator.escape(fields.text)
        };

        try {
            const customerIoResponse = await sendImportEnquiryEmail(user, data);
            res.status(200).json(customerIoResponse);
        } catch (err) {
            res.status(err.status || 500).json(err);
        }
    }
};
