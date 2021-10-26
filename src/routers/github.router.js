const express = require('express');
const router = express.Router();

const {isLoggedIn} = require('./router.utils');
const githubRoutes = require('./routes/github-routes');

router.get('/repo', isLoggedIn, githubRoutes.getRepo);
router.get('/branches', isLoggedIn, githubRoutes.getBranches);

module.exports = router;
