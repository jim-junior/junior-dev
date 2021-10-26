const express = require('express');
const router = express.Router();

const projectRouter = require('./routes/project.routes');

router.post('/github', projectRouter.githubWebhook);
module.exports = router;
