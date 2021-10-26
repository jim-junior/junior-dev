const express = require('express');
const router = express.Router();

const {isLoggedIn} = require('./router.utils');
const ratingRoutes = require('./routes/rating.routes');

router.get('/:category', isLoggedIn, ratingRoutes.getCategoryVote);
router.post('/:category/:item', isLoggedIn, ratingRoutes.categoryVote);

module.exports = router;