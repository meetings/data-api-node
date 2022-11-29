/* session.js
 */

var request = require("request");

exports.validate_user = function( cb, req ) {
    var ssn = req.cookies.oi2ssn;
    ssn = ssn ? ssn : '20c0276ac82ecf3354e1fba92824bfe3'; // corresponds ?user_id=5
    var ssns = req.cookies.oi2ssns;
    var host = req.header('host');
    host = ( host == 'localhost' ) ? 'dev.meetin.gs' : host;

    request.get( {
        url : 'http://' + host + '/meetings_internal/session_info/?secret=internal',
        headers : { "Cookie" : "oi2ssn="+ssn+";oi2ssns="+ssns },
    }, function (error, response, body ) {
        if ( error ) {
            cb( error );
        }
        else {
            var session_info = JSON.parse( body );
            if ( session_info.result.user_id == req.param('user_id') ) {
                cb( null, 1 );
            }
            else {
                cb( null, 0 );
            }
        }
    } );
};
