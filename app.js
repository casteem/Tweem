const steemStream = require('steem');
const steemRequest = require('steem');

const parser = require('./utils/parser');
const targets = {
    twitter: require('./targets/twitter')
}

const { request_nodes, settings, social_networks, steem_accounts, stream_nodes, template } = require('./config');

steemRequest.api.setOptions({ url: request_nodes[0] });

stream();

/** Streams steem operations */
function stream() {
    // Setting the RPC node link based on the current index value
    steemStream.api.setOptions({ url: stream_nodes[0] });
    new Promise((resolve, reject) => {
        console.log('Starting a new stream with ' + stream_nodes[0]);
        // Starting the steem operations stream
        steemStream.api.streamOperations((err, operation) => {
            // Errors are mostly caused by RPC nodes crashing
            if(err) return reject(err);
            // Resteems are inside custom_json operations
            if(steem_accounts.resteems.length > 0 && operation[0] === 'custom_json') {
                const op = JSON.parse(operation[1].json);
                // Checking if it's a resteem and if it's from one of the specified accounts
                if(op[0] === 'reblog' && steem_accounts.resteems.includes(op[1].account)) {
                    processOperation(op[1].author, op[1].permlink, 'resteem');
                }
            // Checking if it's a post (not a comment) made by one of the specified accounts
            } else if(operation[0] === 'comment' && operation[1].parent_author === '') {
                // Regex tests for body containing nothing, only images or only a link to a YouTube video
                const tweetLike = /^((\s*!\[[^\]]*]\([^)]+\))*|\s*((https?:\/\/)?((www|m)\.)?)?youtu(be\.com\/(watch\?v=|embed\/)|\.be\/)[\w-]{10}[048AEIMQUYcgkosw]((\?|&(amp;)?)[^\s&?]+)*)\s*$/.test(operation[1].body);
                if(tweetLike && steem_accounts.tweet_like.includes(operation[1].author)) processOperation(operation[1].author, operation[1].permlink, 'tweet_like');
                else if(!tweetLike && steem_accounts.posts.includes(operation[1].author)) processOperation(operation[1].author, operation[1].permlink, 'post');
            }
        });
    // If an error occured, add 1 to the index and put it at 0 if it is out of bound
    // Then relaunch the stream since it crashed
    }).catch(err => {
        console.error('Stream error:', err.message, 'with', stream_nodes[0]);
        // Putting the node element at the end of the array
        stream_nodes.push(stream_nodes.shift());
        stream();
    });
}

/**
 * Processes a reblog operation or a comment operation
 * @param {string} author The post's author
 * @param {string} permlink The post's permlink
 * @param {string} type The post's type (resteem, post or tweet_like)
 */
function processOperation(author, permlink, type) {
    new Promise((resolve, reject) => {
        // Getting the content of the post
        steemRequest.api.getContent(author, permlink, (err, result) => {
            if(err) return reject(err);
            // If the operation is a comment operation, it must be a post creation, not a post update
            else if(type === 'resteem' || result.last_update === result.created) {
                let metadata;
                try {
                    metadata = JSON.parse(result.json_metadata);
                    if(!metadata) throw new Error('The metadata is ', metadata);
                    if(typeof metadata !== 'object') throw new Error('The metadata is of type ' + typeof metadata);
                } catch(err) {
                    return reject(err);
                }
                // Checking for all the known ways of specifying an app, if none of them exists the app is set to undefined
                const app = metadata.community || (metadata.app && (metadata.app.name || metadata.app.split('/')[0])) || undefined;
                let website = getWebsite(app, result.author, result.permlink, result.url, metadata.tags, result.body);
                // If posting has been allowed for posts from this website
                if(website) {
                    const values = {
                        app: app,
                        author: author,
                        tags: metadata.tags || [result.category],
                        title: result.title
                    }
                    let endLink = '';
                    // Special case for Zappl posts
                    if(app === 'zappl' && steem_accounts.tweet_like.includes(author)) {
                        const zap = result.body.match(/<p[^>]*>([\s\S]+)<\/p>/);
                        if(zap) {
                            // Removing end of text hashtags to avoid duplicates as much as possible
                            values.title = zap[1].replace(/<br( \/)?>/g, '\n').replace(/(#\w+ *)+$/, '');
                            type = 'tweet_like';
                        }
                    }
                    if(type === 'tweet_like') {
                        // Looking for a YouTube link in the title, removing it from the title and shortening it
                        let youtubeLink = values.title.match(/(?:(?:https?:\/\/)?(?:(?:www|m)\.)?)?youtu(?:be\.com\/(?:watch\?v=|embed\/)|\.be\/)([\w-]{10}[048AEIMQUYcgkosw])(?:(?:\?|&(amp;)?)[^\s&?]+)*/);
                        if(youtubeLink) {
                            endLink = ' youtu.be/' + youtubeLink[1];
                            values.title = values.title.replace(youtubeLink[0], '');
                            const youtubeIDRegex = new RegExp(youtubeLink[1]);
                            metadata.image = (metadata.image || []).filter(url => !youtubeIDRegex.test(url))
                        } else {
                            // Looking for a YouTube link in the body and saving a shortened version of it
                            youtubeLink = result.body.match(/(?:(?:https?:\/\/)?(?:(?:www|m)\.)?)?youtu(?:be\.com\/(?:watch\?v=|embed\/)|\.be\/)([\w-]{10}[048AEIMQUYcgkosw])(?:(?:\?|&(amp;)?)[^\s&?]+)*/);
                            if(youtubeLink) {
                                endLink =  ' youtu.be/' + youtubeLink[1];
                                metadata.image = [];
                            }
                        }
                    }
                    for(let target in social_networks) {
                        if(social_networks[target]) {
                            values.link = '%' + '_'.repeat(targets[target].LINK_LENGTH - 2) + '%';
                            let structure = parser.parse(template[type], values);
                            while(structure.parsed.length + endLink.length > targets[target].MAX_LENGTH) {
                                structure = parser.removeLeastImportant(structure);
                            }
                            structure.parsed = structure.parsed.replace(values.link, website) + endLink;
                            targets[target].add(type === 'tweet_like', structure.parsed.replace(/ {2,}/g, ' '), type === 'tweet_like' ? metadata.image || [] : website);
                        }
                    }
                }
            }
        });
    }).catch(err => {
        console.error('Error:', err.message, 'with', request_nodes[0]);
        // Putting the node element at the end of the array
        request_nodes.push(request_nodes.shift());
        steemRequest.api.setOptions({ url: request_nodes[0] });
        console.log('Retrying with', request_nodes[0]);
        processOperation(author, permlink, type);
    });
}

/**
 * Gets the link associated to the post on its original app or on the default app
 * @param {string} app The app associated to the post
 * @param {string} author The post's author
 * @param {string} permlink The post's permlink
 * @param {string} url The post's url (from the blockchain)
 * @param {string[]} tags The post's tags
 * @param {string} body The post's body
 * @returns {string|null} Link associated to the post
 */
function getWebsite(app, author, permlink, url, tags, body) {
    if(!app) {
        // Special case for the Głodni Wiedzy app
        if(author === 'glodniwiedzy') app = author;
        // Special case for the Knacksteem app
        else if(tags[0] === 'knacksteem') app = tags[0];
    }
    if(settings.allowed_apps[app] === 0) return null;
    const allowedDefaultApps = ['blockpress', 'busy', 'coogger', 'insteem', 'steemd', 'steemdb', 'steemit', 'steemkr', 'steempeak', 'steemstem', 'steeve', 'strimi', 'ulogs', 'uneeverso'];
    // If the app specified in settings.default_app doesn't exist, doesn't support viewing posts, isn't yet supported or isn't correctly written, use Steemit as the default app
    const defaultApp = allowedDefaultApps.includes(settings.default_app) ? settings.default_app : 'steemit';
    if(settings.allowed_apps[app] === 1 || !settings.allowed_apps.hasOwnProperty(app)) app = defaultApp;
    switch(app) {
        case 'bescouted':
            // Bescouted links don't follow the Steem apps logic, therefore the link has to be fetched from the body
            const link = body.match(/\(?:https:\/\/www\.(bescouted\.com\/photo\/\d{8,}\/[\w-]+\/\d{8,})\/\)/);
            // If the user removed the website link, the post is linked to the default app
            if(link) return link[0];
            else return getWebsite(defaultApp, author, permlink, url, tags, body);
        case 'blockdeals':
            return 'blockdeals.org' + url;
        case 'blockpress':
            return 'blockpress.me/?p=steem' + url;
        case 'busy':
            return 'busy.org/@' + author + '/' + permlink;
        case 'contest_hero':
            return 'www.contesthero.io/view-contest/' + author + '/' + permlink;
        case 'coogger':
            return 'www.coogger.com/@' + author + '/' + permlink;
        case 'dlike':
            return 'dlike.io/post/' + author + '/' + permlink;
        case 'dmania':
            return 'dmania.lol/post/' + author + '/' + permlink;
        case 'dpoll':
            return 'dpoll.xyz/detail/@' + author + '/' + permlink;
        case 'dsound':
            return 'dsound.audio/#!/@' + author + '/' + permlink;
        case 'dtube':
            return 'd.tube/#!/v/' + author + '/' + permlink;
        case 'fundition':
            return 'fundition.io/#!/@' + author + '/' + permlink;
        case 'glodniwiedzy':
            return 'glodniwiedzy.pl/' + permlink;
        case 'hede':
            return 'hede.io' + url;
        case 'insteem':
            return 'www.insteem.com/stories/' + author + '/' + permlink;
        case 'knacksteem':
            return 'knacksteem.org/articles/' + author + '/' + permlink;
        case 'memeit.lol':
            return 'memeit.lol/@' + author + '/' + permlink;
        case 'mTasks':
            return 'steemmtask.herokuapp.com/@' + author + '/' + permlink;
        case 'parley':
            return 'parley.io/thread/' + author + '/' + permlink;
        case 'steemd':
            return 'steemd.com' + url;
        case 'steemdb':
            return 'steemdb.com' + url;
        case 'steemgig':
            return 'steemgigs.org/@' + author + '/' + permlink;
        case 'steemhunt':
            return 'steemhunt.com/@' + author + '/' + permlink;
        case 'steemit':
            return 'steemit.com' + url;
        case 'steemkr':
            return 'steemkr.com' + url;
        case 'steempeak':
            return 'steempeak.com' + url;
        case 'steemstem':
            return 'www.steemstem.io/#!/@' + author + '/' + permlink;
        case 'steepshot':
            return 'alpha.steepshot.io/post/@' + author + '/' + permlink;
        case 'steeve':
            return 'www.steeve.app/@' + author + '/' + permlink;
        case 'strimi':
            return 'strimi.pl' + url;
        case 'ulogs':
            return 'ulogs.org/@' + author + '/' + permlink;
        case 'uneeverso':
            return 'www.uneeverso.com' + url;
        case 'utopian':
            return 'utopian.io' + url;
        case 'vimm.tv':
            return 'www.vimm.tv/@' + author;
        case 'zappl':
            return 'zappl.com' + url.split('/')[1] + '/' + author + '/' + permlink;
        default:
            // This default action shouldn't ever be reached and has been left there just in case something unforeseen happens
            return getWebsite(defaultApp, author, permlink, url, tags, body);
    }
}