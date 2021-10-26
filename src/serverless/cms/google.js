const _ = require('lodash');
const logger = require('../../services/logger');
const googleService = require('../../services/google-services/google-service');
const googleConfig = require('../../config').default.google;
const {createPageFile, createDataFile} = require('./cms-common-utils');

function fetchGoogleDocs(docId, accessToken, refreshToken, user, options) {
    logger.debug('Serverless: running Google Docs');

    const {google} = require('googleapis');
    let oauth2Client;
    if (user) {
        oauth2Client = googleService.getAuthClient(user);
    } else {
        oauth2Client = new google.auth.OAuth2(googleConfig.appClientId, googleConfig.appClientSecret);
        oauth2Client.setCredentials({
            access_token: accessToken,
            refresh_token: refreshToken
        });
    }

    const driveClient = google.drive({
        version: 'v3',
        auth: oauth2Client
    });

    return Promise.all([
        driveClient.files.export({fileId: docId, mimeType: 'text/html'}),
        driveClient.files.get({fileId: docId, fields: 'name,thumbnailLink'})
    ]).then(([pageResponse, pageMetaResponse]) => {
        logger.debug('Serverless: filtering entries');

        const html = pageResponse.data;
        const name = pageMetaResponse.data.name;
        const thumbnailLink = pageMetaResponse.data.thumbnailLink;

        return createPage(html, name, thumbnailLink, options);
    });
}

function matchTag(tag) {
    return new RegExp(`<${tag}[\\s\\S]*?>([\\s\\S]*?)<\\/${tag}>`, 'igm');
}

function getTagContents(tag, string) {
    const reg = matchTag(tag);
    const result = [];
    let current;

    while ((current = reg.exec(string)) !== null) {
        result.push(current[1]);
    }

    return result.join('\n');
}

function getTagAttributes(tag, attr, string) {
    const reg = new RegExp(`<${tag}[\\s\\S]?${attr}="?(.+?)"?>`, 'ig');
    const match = reg.exec(string);
    return match ? match[1] : '';
}

function createPage(html, title, thumbnailLink, options) {
    const content = cleanupContent(getTagContents('body', html));
    const script = getTagContents('script', html);
    const style = cleanupStyles(getTagContents('style', html));

    const pageStyle = getTagAttributes('body', 'style', html);
    const pageBackground = pageStyle
        .split(';')
        .filter(attr => attr.startsWith('background-color'))[0];

    const pageBackgroundColor = pageBackground ? pageBackground.split(':')[1] : null;

    const dataFile = createDataFile({
        stackbit_file_path: 'data.json',
        script,
        style,
        title,
        thumbnailLink,
        pageBackgroundColor,
        content
    }, null, options);

    return [dataFile];
}

function cleanupContent(html) {
    // remove comments in footer and links to them
    html = html
        .replace(/<sup>(?=<a href="#cmnt.+?".+?>).+?<\/sup>/ig, '')
        .replace(/<div[^<]+?><p[^<]+?>(?=<a href="#cmnt_.+?".+?>).+?<\/p><\/div>/ig, '');

    // fix links redirection to google confirmation site
    let current;
    while ((current = /"https:\/\/www.google.com\/url\?q=(.+?)&.+?"/igm.exec(html)) !== null) {
        const url = decodeURIComponent(current[1]);
        html = html.replace(current[0], `"${url}"`);
    }

    // add class names to span which holds images
    while ((current = /(<span) style="[^"]+?">(?=<img).+?><\/span>/igm.exec(html)) !== null) {
        const res = current[0].replace(current[1], current[1] + ' class="image-block"');
        html = html.replace(current[0], res);
    }

    // wrap li contents inside div
    while ((current = /<li[^>]+?>(?!<div)(.+?)<\/li>/igm.exec(html)) !== null) {
        const res = current[0].replace(current[1], `<div>${current[1]}</div>`);
        html = html.replace(current[0], res);
    }

    // if table has margin - add class so it can be controlled from the css
    while ((current = /<table[^>]style="[^"]*?margin-left:(\d*\.?\d*)([a-z]+?);.+?>/igm.exec(html)) !== null) {
        const res = current[0].replace('<table', '<table class="table-margin"');
        html = html.replace(current[0], res);
    }

    return html;
}

function cleanupStyles(style) {
    let current;

    while ((current = /content:".+?( )+?"}/igm.exec(style)) !== null) {
        const res = current[0].replace(/ +?"}/, '"}');
        style = style.replace(current[0], res);
    }

    return style;
}

module.exports = {
    // fetchGoogleDocs
};
