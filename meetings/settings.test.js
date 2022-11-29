/* settings.test.js
 */

exports.get = function( key ) {
    var s = {
        gearman_servers : [
            { host : '127.0.0.1', port : '4730' },
            { host : '127.0.0.1', port : '4731' }
        ],
        pusher_config : {
            appId: '79408',
            key: 'acc4855651c9884f9717',
            secret: 'x'
        },
        attachment_store_url : 'https://test.meetin.gs/draft_attachment_json/store'
    };

    return s[ key ];
};
