const _ = require('lodash');
const axios = require('axios');
const queryString = require('query-string');
const config = require('../../config').default;
const logger = require('../logger');
const Project = require('../../models/project.model').default;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function fetchDailyWidgetVisitors({limit = 20000, daysOffset = 0, days = 1}) {
    const from = Date.now() - ((days+daysOffset) * DAY_IN_MS);
    const to = from + (days*DAY_IN_MS);
    const queryParams = {
        limit,
        timezone: '+0000',
        from,
        to
    };

    const headers = {
        Authorization: `Bearer ${config.insights.netlifyWidgetSiteAccessToken}`
    };

    const url = `${config.insights.netlifyAnalyticsBaseUrl}/${config.insights.netlifyWidgetSiteId}/ranking/sources?${queryString.stringify(queryParams)}`;
    return axios
        .get(url, { headers })
        .then(resp => {
            let data = resp.data.data;
            if (data.length === limit) {
                logger.warn('Insights Service: Widget analytics doubling fetch limit', {limit});
                return fetchDailyWidgetVisitors({limit: limit*2, daysOffset, days});
            }

            logger.debug('Insights Service: Widget analytics fetched sources', {dataLength: data.length, limit, daysOffset, days});
            return resp.data.data.reduce((acc, cur) => {
                if (!cur.resource) {    // clean up blank entry
                    return acc;
                }
                const fullUrl = cur.resource.match('^https?://') ? cur.resource : `https://${cur.resource}`;
                const hostname = new URL(fullUrl).hostname;
                if (hostname.endsWith('.stackbit.dev')) {
                    return acc;
                }

                if (acc[hostname]) {
                    acc[hostname] += cur.count;
                } else {
                    acc[hostname] = cur.count;
                }
                return acc;
            }, {});
        });
}

async function updateInsights({limit = 20000, daysOffset = 0} = {}) {
    const offsetDay = Date.now() - ((daysOffset) * DAY_IN_MS);
    const date = new Date(offsetDay).setUTCHours(0, 0, 0, 0);
    logger.debug('Insights Service: fetching insights', {date: new Date(date), daysOffset, limit});
    const widgetVisitors = await fetchDailyWidgetVisitors({limit, daysOffset});
    const widgetMonthlyVisitors = await fetchDailyWidgetVisitors({limit, daysOffset, days: 30});
    const siteUrls = _.uniq(Object.keys(widgetVisitors).concat(Object.keys(widgetMonthlyVisitors))).map(item => `https://${item}`);
    const projects = await Project.getProjectIdsForSiteUrls(siteUrls);
    const queries = _.compact(projects.map(project => {
        const url = new URL(project.siteUrl).hostname;
        return {
            projectId: project.id,
            date: date,
            dailyVisits: widgetVisitors[url] || 0,
            monthlyVisits: widgetMonthlyVisitors[url] || 0
        };
    }));
    logger.debug(`Insights Service: updating insights for ${queries.length} projects`, {date});
    return Project.updateProjectInsights(queries);
}

module.exports = {
    updateInsights
};
