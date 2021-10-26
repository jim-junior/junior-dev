const express = require('express');
const router = express.Router();

const {isLoggedIn} = require('./router.utils');
const netlifyRoutes = require('./routes/netlify.routes');

router.get('/sites', isLoggedIn, netlifyRoutes.getNetlifySites);

module.exports = router;
