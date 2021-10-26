#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.length < 2) {
    console.error('spaceId and/or accessToken were not provided\nUsage:\n./pull-contentful.js <space_id> <content_delivery_access_token>');
    process.exit(1);
}

require('../config').loadConfig().catch(err => {
    console.error('Error loading config:', err);
    process.exit(1);
}).then(() => {
    const pullContentful = require('../serverless/cms/contentful').buildCMS;

    const spaceId = args[0];
    const accessToken = args[1];
    const ssgType = null;
    const options = {
        preview: true,
        dataFormat: 'object',
        metadata: true
    };

    return pullContentful(spaceId, ssgType, accessToken, options).then((data) => {
        console.log('encodedData:', JSON.stringify(data, null, 4));
    });
}).catch(err => {
    console.error('Error:', err);
});
