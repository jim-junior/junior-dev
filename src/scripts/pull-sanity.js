#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.length < 3) {
    console.error('projectId and/or dataset and/or accessToken were not provided\nUsage:\n./pull-sanity.js <project_id> <dataset> <access_token>');
    process.exit(1);
}

require('../config').loadConfig().catch(err => {
    console.error('Error loading config:', err);
    process.exit(1);
}).then(() => {
    const pullSanity = require('../serverless/cms/sanity').buildCMS;

    const projectId = args[0];
    const dataset = args[1];
    const accessToken = args[2];
    const ssgType = null;
    const options = {
        preview: true,
        dataFormat: 'object',
        metadata: true
    };

    pullSanity(projectId, dataset, ssgType, accessToken, options).then((data) => {
        console.log('encodedData:', JSON.stringify(data, null, 4));
    });

}).catch(err => {
    console.error('Error:', err);
});
