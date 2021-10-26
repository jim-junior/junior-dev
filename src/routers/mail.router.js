const express = require('express');
const router = express.Router();
const { isLoggedIn } = require('./router.utils');
const mailRoutes = require('./routes/mail.routes');

router.post('/import-enquiry', isLoggedIn, mailRoutes.sendImportEnquiry);

module.exports = router;
