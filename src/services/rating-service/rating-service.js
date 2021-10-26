const Rating = require('../../models/rating.model');

function categoryVote(category, item, userId) {
    return Rating.categoryVote(category, item, 1, userId);
}

function getCategoryVote(category, userId) {
    return Rating.getCategoryVote(category, userId);
}

module.exports = {
    categoryVote,
    getCategoryVote
};