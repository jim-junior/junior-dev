const express = require('express');
const router = express.Router();
const {isLoggedIn} = require('./router.utils');

const emailvalidationRoutes = require('./routes/email-validation.routes');

router.get('/my', isLoggedIn, emailvalidationRoutes.getMyEmailValidationTokens);
router.get('/resend-validation-email', isLoggedIn, emailvalidationRoutes.resendValidationEmail);

module.exports = router;
