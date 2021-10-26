const passport = require('passport');
const path = require('path');
const Project = require('../../models/project.model').default;
const analytics = require('../../services/analytics/analytics');
const logger = require('../../services/logger');
const NetlifyService = require('../../services/netlify-services/netlify-service');

module.exports = {
    netlifyCallback: (req, res) => {
        const {user} = req;
        return Project.findAnonClaimableProjects(user.id).then(projects => {
            if (projects && projects.length) {
                logger.debug('Netlify Connect: Found claimable projects', {userId: user.id, foundProjects: projects.length});
                return NetlifyService.claimAnonNetlifySites(user.id, user.netlifyAccessToken).then(() => {
                    return Project.updateClaimableProjects(user.id).then(() => {
                        projects.forEach(project => {
                            analytics.track('Netlify Anonymous Site Claimed', {
                                projectId: project.id,
                                userId: user.id
                            }, user);
                        });
                    });
                });
            }
        }).finally(() => {
            analytics.identify(req.user, req);
            res.sendFile(path.join(__dirname, '../../services/auth-service/post-auth.html'));
            analytics.track('[Auth] Connect Success', {
                userId: req.user.id,
                type: 'netlify',
                projectId: analytics.projectIdFromRequest(req)
            }, req.user);
        });
    }
};
