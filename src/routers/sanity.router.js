const express = require('express');
const router = express.Router();

const {isLoggedIn} = require('./router.utils');
const sanityRoutes = require('./routes/sanity.routes');

router.get('/user/my', isLoggedIn, sanityRoutes.getUser);
router.get('/project/my', isLoggedIn, sanityRoutes.getProjects);
router.get('/project/:id/datasets', isLoggedIn, sanityRoutes.getProjectDatasets);

module.exports = router;
