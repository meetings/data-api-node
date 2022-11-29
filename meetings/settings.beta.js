/* settings.beta.js
 */

exports.get = function( key ) {
    var s = {
        gearman_servers : [
            { host : '127.0.0.1', port : '4730' }
        ],
        pusher_config : {
            appId: '79410',
            key: '8626829005c0e1e62345',
            secret: 'x'
        },
        core_domain : 'https://beta.meetin.gs',
        attachment_store_url : 'https://beta.meetin.gs/draft_attachment_json/store'
    };

    return s[ key ];
};
