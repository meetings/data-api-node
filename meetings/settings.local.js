/* settings.local.js
 */

exports.get = function( key ) {
    var s = {
        gearman_servers : [
            { host : '127.0.0.1', port : '4730' }
        ],
        pusher_config : {
            appId: '79408',
            key: 'acc4855651c9884f9717',
            secret: 'x'
        },
        core_domain : 'https://local.meetin.gs',
        attachment_store_url : 'https://local.meetin.gs/draft_attachment_json/store'
    };

    return s[ key ];
};
