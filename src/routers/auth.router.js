const express = require('express');
const router = express.Router();
const passport = require('passport');
const { isLoggedIn } = require('./router.utils');
const authRoutes = require('./routes/auth.routes');
const githubAuthRoutes = require('./routes/auth-github.routes');
const googleAuthRoutes = require('./routes/auth-google.routes');
const netlifyAuthRoutes = require('./routes/auth-netlify.routes');
const genericAuthRoutes = require('./routes/auth-generic.routes');

router.post('/register', authRoutes.register);
router.post('/login', passport.authenticate('local'), authRoutes.login);
router.get('/logout', authRoutes.logout);
router.post('/forgot-password', authRoutes.forgotPassword);
router.post('/reset-password', authRoutes.resetPassword);
router.post('/update-password', isLoggedIn, authRoutes.updatePassword);

router.get('/google', genericAuthRoutes.baseAuthHandler.bind(null, 'google'), googleAuthRoutes.googleAuth);
router.get('/google/callback', passport.authenticate('google'), genericAuthRoutes.genericAuthCallback.bind(null, 'google'));
router.get('/google/refresh', isLoggedIn, googleAuthRoutes.googleRefresh);

router.get('/github-app', genericAuthRoutes.baseAuthHandler.bind(null, 'github-app'), genericAuthRoutes.genericAuth.bind(null, 'github-app'));
router.get('/github-app/callback', passport.authenticate('github-app'), githubAuthRoutes.githubCallback);
router.get('/github/my', isLoggedIn, githubAuthRoutes.githubUser);

// github app routes
router.get('/github/installations', isLoggedIn, githubAuthRoutes.githubInstallations);
router.get('/github/install-callback', githubAuthRoutes.githubInstallCallback);

router.get('/netlify', genericAuthRoutes.baseAuthHandler.bind(null, 'netlify'), genericAuthRoutes.genericAuth.bind(null, 'netlify'));
router.get('/netlify/callback', passport.authenticate('netlify'), netlifyAuthRoutes.netlifyCallback);

router.get('/contentful', genericAuthRoutes.baseAuthHandler.bind(null, 'contentful'), genericAuthRoutes.genericAuth.bind(null, 'contentful'));
router.get('/contentful/callback', passport.authenticate('contentful'), genericAuthRoutes.genericAuthCallback.bind(null, 'contentful'));

router.get('/forestry', genericAuthRoutes.baseAuthHandler.bind(null, 'forestry'), genericAuthRoutes.genericAuth.bind(null, 'forestry'));
router.get('/forestry/callback', passport.authenticate('forestry'), genericAuthRoutes.genericAuthCallback.bind(null, 'forestry'));
router.get('/forestry/refresh', isLoggedIn, authRoutes.forestryRefresh);

router.get('/sanity', genericAuthRoutes.baseAuthHandler.bind(null, 'sanity'), genericAuthRoutes.genericAuth.bind(null, 'sanity'));
router.get('/sanity/callback', passport.authenticate('sanity'), genericAuthRoutes.genericAuthCallback.bind(null, 'sanity'));
router.get('/sanity/token', authRoutes.sanityToken);

router.get('/datocms', genericAuthRoutes.baseAuthHandler.bind(null, 'datocms'), genericAuthRoutes.genericAuth.bind(null, 'datocms'));
router.get('/datocms/callback', passport.authenticate('datocms'), genericAuthRoutes.genericAuthCallback.bind(null, 'datocms'));

router.get('/devto', genericAuthRoutes.baseAuthHandler.bind(null, 'devto'), genericAuthRoutes.genericAuth.bind(null, 'devto'));
router.get('/devto/callback', passport.authenticate('devto'), genericAuthRoutes.genericAuthCallback.bind(null, 'devto'));
router.get('/devto/my', isLoggedIn, authRoutes.devtoGetUser);

router.get('/validate-email', authRoutes.validateEmail);

router.get('/connection/:connectionType/disconnect', genericAuthRoutes.genericDisconnect);

router.get('/azure', genericAuthRoutes.baseAuthHandler.bind(null, 'azure'), genericAuthRoutes.genericAuth.bind(null, 'azure'));
router.post('/azure/callback', passport.authenticate('azure'), genericAuthRoutes.genericAuthCallback.bind(null, 'azure'));

router.get('/digitalocean', genericAuthRoutes.baseAuthHandler.bind(null, 'digitalocean'), genericAuthRoutes.genericAuth.bind(null, 'digitalocean'));
router.get('/digitalocean/callback', passport.authenticate('digitalocean'), genericAuthRoutes.genericAuthCallback.bind(null, 'digitalocean'));

module.exports = router;
