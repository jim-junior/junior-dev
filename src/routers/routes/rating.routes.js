const logger = require('../../services/logger');
const analytics = require('../../services/analytics/analytics');
const ratingService = require('../../services/rating-service/rating-service');

module.exports = {
    categoryVote: (req, res) => {
        const user = req.user;
        const {category, item} = req.params;
        return ratingService.categoryVote(category, item, user.id).then(result => {
            res.json(result);
            analytics.track('Wizard Card Voted', {
                category,
                item,
                userId: user.id,
                projectId: analytics.projectIdFromRequest(req)
            }, user);
        }).catch(err => {
            res.status(err.status || 500).json(err);
        });
    },
    getCategoryVote: (req, res) => {
        const user = req.user;
        const {category} = req.params;
        return ratingService.getCategoryVote(category, user.id).then(result => {
            res.json(result);
        }).catch(err => {
            res.status(err.status || 500).json(err);
        });
    }
};
