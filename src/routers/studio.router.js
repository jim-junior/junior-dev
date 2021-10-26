const express = require('express');
const router = express.Router();

const {isLoggedIn} = require('./router.utils');
const studioRoutes = require('./routes/studio.routes');

router.post('/:id/add-contentful-space', isLoggedIn, studioRoutes.addContentfulSpaceToProject);
router.post('/:id/migrate-contentful-space', isLoggedIn, studioRoutes.migrateContentfulSpaceToArray);
router.post('/:id/enable-preview', isLoggedIn, studioRoutes.enablePreview);

module.exports = router;
