const express = require('express');
const passport = require('passport');
const router = express.Router();

const widgetRoutes = require('./routes/widget.routes');
const authRoutes = require('./routes/auth.routes');
const projectRoutes = require('./routes/project.routes');

const {isLoggedIn, isLoggedInWithOk} = require('./router.utils');

router.use((req, res, next) => {
    passport.authenticate('widget', { session: false }, (err, user) => {
        if (err || !user) {
            return res.status(401).json({error: 'Unauthorized', message: 'Access token not valid'});
        }
        req.user = user;
        next(err);
    })(req, res, next);
});

router.get('/sites', isLoggedIn, widgetRoutes.getProjects);
router.get('/logout', authRoutes.logout);
router.get('/check-name', isLoggedIn, projectRoutes.checkName);
router.get('/:id?', isLoggedInWithOk, widgetRoutes.getProject); // (!) Deprecated
router.post('/:id?', isLoggedInWithOk, widgetRoutes.getProject);
router.post('/:id/action', isLoggedIn, widgetRoutes.makeAction);

router.post('/:id/delete', isLoggedIn, projectRoutes.deleteProject);
router.post('/:id/rename', isLoggedIn, projectRoutes.renameProject);
router.post('/:id/build', isLoggedIn, projectRoutes.buildProject);
router.post('/:id/publish-content', isLoggedIn, projectRoutes.publishContent);
router.post('/:id/has-changes', isLoggedIn, projectRoutes.hasChanges);

module.exports = router;
