
const _ = require('lodash');

const url = require('url');
const refresh = require('passport-oauth2-refresh');
const matter = require('gray-matter');
const service = require('../../services/devto-services/devto-service');
const logger = require('../../services/logger');
const {createPageFiles, createDataFiles, getLayoutKey} = require('./cms-common-utils');

const IFRAME_STYLE = 'border: 0; width: 100%;';

function fetchDevTo(user, ssgType, accessToken, options, retry=false) {
    logger.debug('Serverless: running DEV');
    return service.getArticles(user).then(articles => {
        logger.debug('Serverless: filtering entries');
        
        let files = [];

        const pages = articles.map(article => createPage(ssgType, article));
        files.push(...createPageFiles(pages, ssgType, options));

        const data = createData(articles);
        if (!_.isEmpty(data)) {
            files.push(...createDataFiles([data], ssgType, options));
        }

        return files;
    }).catch(err => {
        if (!retry && err === service.Errors.Unauthorized) {
            logger.debug('DEV: Refreshing access token');
            const connection = _.find(user.connections, {type: 'devto'});
            refresh.requestNewAccessToken('devto', connection.refreshToken, (refreshErr, accessToken, refreshToken) => {
                if (refreshErr) {
                    throw err;
                }
                return user.addConnection('devto', {accessToken, refreshToken}).then(() => {
                    logger.debug('DEV: Access token refreshed');
                    return fetchDevTo(user, ssgType, accessToken, options, true);
                });
            });
        }
        throw err;
    });
}

function prepareContent(ssgType, article) {
    let result = article.body_markdown;

    if (matter.test(result)) {
        let body = result.trim().substring(4);
        const closingDelimIndex = body.indexOf('\n---');
        if (closingDelimIndex >= 0) {
            result = body.substring(closingDelimIndex + 4);
        } 
    } 

    // markdown tweaks 
    result = result.replace(/(#+)([^ #])/g, '$1 $2'); // add trailing space for headers

    let codeRanges = [];
    const codePattern = /`+([\s\S]*?)`+/g;
    result = result.replace(codePattern, (match, tag, offset) => {
        if (ssgType === 'jekyll') {
            return `{% raw %}${match}{% endraw %}`;
        }
        return `\n${match}\n`;
    });
    let match;
    while ((match = codePattern.exec(result)) !== null) {
        codeRanges.push([match.index, match.index + match[0].length]);
    }

    // liquid tags handling
    result = result.replace(/{%([\s\S]*?)%}/g, (match, tag, offset) => {
    
        // don't convert tags appearing within jekyll raw block
        if (ssgType === 'jekyll' && ['raw','endraw'].includes(tag.trim())) {
            return match;
        }

        // don't convert tags appearing within code block
        if (_.find(codeRanges, (range) => offset >= range[0] && offset <= range[1])) {
            // escape hugo shortcode within code block
            if (ssgType === 'hugo' && 
                offset > 0 && 
                result[offset-1] === '{' && 
                offset+match.length < result.length && 
                result[offset+match.length] === '}') {

                return `{%/* ${tag} */%}`;
            }
            return match;
        }

        const parts = tag
            .replace(/\n/g, ' ')
            .replace(/\\_/g, '_')
            .trim()
            .split(' ');
        const tagName = parts[0];
        const tagArgs = encodeURIComponent(parts.slice(1).join(' '));

        return `
<iframe class="liquidTag" src="https://dev.to/embed/${tagName}?args=${tagArgs}" style="${IFRAME_STYLE}"></iframe>
`;
    });

    // add canonical link
    if (article.url && 
        url.parse(article.url).hostname === 'dev.to') {
            
        result += `

*[This post is also available on DEV.](${article.url})*

`;
    }

    // inject frame-resizer
    result += `
<script>
const parent = document.getElementsByTagName('head')[0];
const script = document.createElement('script');
script.type = 'text/javascript';
script.src = 'https://cdnjs.cloudflare.com/ajax/libs/iframe-resizer/4.1.1/iframeResizer.min.js';
script.charset = 'utf-8';
script.onload = function() {
    window.iFrameResize({}, '.liquidTag');
};
parent.appendChild(script);
</script>    
`;

    return result;
}

function createPage(ssgType, article) {
    const content = prepareContent(ssgType, article);
    let page = {
        stackbit_url_path: 'posts/' + article.slug,
        content: content,
        title: article.title,
        date: article.published_at,
        excerpt: article.description,
        thumb_img_path: article.cover_image,
        comments_count: article.comments_count,
        positive_reactions_count: article.positive_reactions_count,
        tags: _.isEmpty(article.tag_list) ? [] : article.tag_list,
        canonical_url: article.canonical_url || article.url,
    };
    page[getLayoutKey(ssgType)] = 'post';
    return page;
}

function createData(articles) {
    let result = {};
    if (!_.isEmpty(articles)) {
        const user = articles[0].user;
        result = {
            stackbit_file_path: 'data.json',
            author: {
                name: user.name,
                avatar: user.profile_image
            },
            social: {}
        };
        if (user.username) {
            result.social.devto = { username: user.username };
        }
        if (user.twitter_username) {
            result.social.twitter = { username: user.twitter_username };
        }
        if (user.github_username) {
            result.social.github = { username: user.github_username };
        }
    }
    return result;
}

module.exports = {
    fetchDevTo
};
