const _ = require('lodash');
const dateFns = require('date-fns');

function calculateProjectScore(project) {
    let score = 0;

    if (project.metrics.deploySuccessCount > 3) {
        score += 1;
    }
    if (project.metrics.deploySuccessCount > 100) {
        score += 1;
    }
    if (project.metrics.deploySuccessCount > 1000) {
        score += 1;
    }

    if (project.metrics.hasDeveloperCommits) {
        score += 1;
    }

    if (project.deployedAt) {
        const age = dateFns.differenceInDays(new Date(), new Date(project.deployedAt));
        if (age <= 7) {
            score += 1;
        }
    }
    if (project.lastDeveloperCommitAt) {
        const age = dateFns.differenceInDays(new Date(), new Date(project.lastDeveloperCommitAt));
        if (age <= 7) {
            score += 1;
        }
    }

    const hasCustomDomain = projectHasCustomDomain(project.siteUrl);
    if (hasCustomDomain) {
        score += 3;
    }

    if (score > 10) {
        score = 10;
    }
    if (score < 0) {
        score = 0;
    }
    return score;
}

function projectHasCustomDomain(siteUrl) {
    const re = new RegExp('netlify', 'i');
    return siteUrl.match(re) == null;
}



module.exports = {
    calculateProjectScore
};
