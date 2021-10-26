const {getSites} = require('../../services/netlify-services/netlify-service');

const getNetlifySites =(req, res) => {
    return getSites(req.user.netlifyAccessToken)
        .then(sites => {
            res.json(sites);
        })
        .catch(err => {
            res.status(err.status || 500).json(err);
        });
};

module.exports = {
    getNetlifySites
};
