// app.js
// vi: set sw=4 ts=4 sts=4 ft=javascript :

/*jslint todo: true, vars: true, eqeq: true, nomen: true, sloppy: true, white: true, unparam: true, node: true */

var _ = require('underscore');
var fs = require('fs');
var md5 = require('md5');
var util = require('util');
var url = require('url');
var pool = require('./pool');
var async = require('async');
var express = require('express');
var request = require('request');
var session = require('./session');
var abraxas = require('abraxas');
var traverse = require('traverse');
var settings = require('./settings');
var user_data = require('./user/data');
var exec = require('child_process').exec;
var hostname = require('os').hostname();
var process_id = process.pid;
var app = express();
var events_arr = [];
var Pusher = require( 'pusher' );


/* Log string format with following changes from default:
 *  Date removed, because it comes from syslog.
 *  Previous replaced with response time.
 *  User id added.
 */
var log_string = ':origin_ip :response-time ms ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" ":app_version" :user_id :request_id';

function resolve_origin_ip( req ) {
    var xff = req.headers['x-forwarded-for'] || '';
    var addr = xff.toString().split(/\s*\,\s*/).shift();
    return addr || req.connection.remoteAddress || '-';
}

function resolve_auth_user_id( req ) {
    if ( req.headers.dic ) { return req.headers.user_id; }
    return req.query ? ( req.query.user_id || req.body.user_id ) : req.body.user_id;
}

function request_id( req ) {
    if ( req.hasOwnProperty( 'meetings_session_id' ) ) {
        return req.meetings_session_id;
    }

    var microtime = Date.now().toString();
    var user_id = resolve_auth_user_id(req);

    req.meetings_session_id = md5.digest_s( hostname + process_id + user_id + microtime);
    return req.meetings_session_id;
}

function app_version( req ) {
    return req.headers['x-meetings-app-version'] || '';
}

express.logger.token('origin_ip', function(req, res) {
    return resolve_origin_ip(req);
});

express.logger.token('user_id', function(req, res) {
    return resolve_auth_user_id(req);
});

express.logger.token('request_id', function(req, res) {
    return request_id( req );
});

express.logger.token('app_version', function(req, res) {
    return app_version( req );
});

app.configure(function() {
    // Handle pool requests before logging to avoid log flood.
    app.use('/pool', pool);

    app.use(express.compress());
    app.use(express.bodyParser());
    app.use(express.logger(log_string));

    app.use(function(req, res, next) {
        // no caching
        res.header("Cache-Control", "no-cache, no-store, must-revalidate");
        res.header("Pragma", "no-cache");
        res.header("Expires", 0);

        var oneof = false;
        if(req.headers.origin) {
            res.header('Access-Control-Allow-Origin', req.headers.origin);
            oneof = true;
        }
        if(req.headers['access-control-request-method']) {
            res.header('Access-Control-Allow-Methods', req.headers['access-control-request-method']);
            oneof = true;
        }
        if(req.headers['access-control-request-headers']) {
            res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
            oneof = true;
        }
        if(oneof) {
            res.header('Access-Control-Max-Age', 60 * 60 * 24 * 365);
        }

        // intercept OPTIONS method
        if (oneof && req.method === 'OPTIONS') {
            res.send(200);
        }
        else {
            next();
        }
    });
});

function resolve_lang( req ) {
    if ( req.headers.lang ) { return req.headers.lang; }
    return req.query ? ( req.query.lang || req.body.lang || 'en' ) : req.body.lang || 'en';
}

function resolve_auth_token( req ) {
    if ( req.headers.dic ) { return req.headers.dic; }
    return req.query ? ( req.query.dic || req.body.dic ) : req.body.dic;
}

function resolve_param_user_id( req ) {
    if ( req.params.id === 'me' ) {
        return resolve_auth_user_id( req );
    }
    return req.params.id;
}

function fill_and_stringify_params( params, opts ) {
    if( typeof params === 'object' ) {
        if ( ! params.lang && opts && opts.req ) {
            params.lang = resolve_lang( opts.req ) || 'en';
        }
        if ( ! params.auth_user_id && opts && opts.req ) {
            params.auth_user_id = resolve_auth_user_id( opts.req ) || 0;
        }
        if ( ! params.request_id && opts && opts.req ) {
            params.request_id = request_id( opts.req );
        }
        if ( ! params.app_version && opts && opts.req ) {
            params.app_version = opts.req.headers['x-meetings-app-version'] || '';
        }
        return JSON.stringify( params );
    }

    return params;
}

function proper_gearman_run_job_with_state( name, args, callback, opts, state ) {
    if ( isNaN( opts.timeout ) || opts.timeout === null ) {
        opts.timeout = 5*60*1000;
    }

    if ( state.server_fail_count >= opts.servers.length ) {
        state.job_fail_count += 1;
        state.server_fail_count = 0;
    }

    if ( state.job_fail_count > state.retry_count ) {
        return callback( state.last_error || { message: "Unknown error" } );
    }

    var client = abraxas.Client.connect( {
        host : opts.servers[ state.server_index ].host,
        port : opts.servers[ state.server_index ].port,
        defaultEncoding : 'utf8',
    } );

    var round_is_handled = false;
    var round_has_timed_out = false;

    var retry = function( error ) {
        if ( round_is_handled ) {
            console.log( 'ERROR: tried to handle job twice (retry after handled) -- ' + error );
            return;
        }
        round_is_handled = true;
        client.disconnect();
        state.server_index = ( state.server_index + 1 ) % opts.servers.length;
        state.last_error = error;
        proper_gearman_run_job_with_state( name, args, callback, opts, state );
    };

    client.on( 'error', function( error ) {
        //These errors are just ignored as job propagates this as promise error
        return;
    } );

    var job_promise = opts.background ?
        client.submitJobBg( name, {}, args ) :
        client.submitJob( name, {}, args );

    if ( opts.timeout ) {
        setTimeout( function() {
            if ( round_is_handled ) {
                return;
            }
            else {
                round_has_timed_out = true;
                client.disconnect();
                return callback( { message : "ClientTimeout" } );
            }
        }, opts.timeout );
    }

    job_promise.then( function( payload ) {
        if ( round_has_timed_out ) {
            return;
        }
        if ( round_is_handled ) {
            console.log( 'ERROR: tried to handle job twice (success after handled)');
            return;
        }
        var reply = null;
        round_is_handled = true;
        try {
            reply = JSON.parse( payload );
        }
        catch (e) {
            // assume payload was plain text if not json
            reply = payload;
        }
        callback( null, reply );
        client.disconnect();
    } ).catch( function( error ) {
        if ( round_has_timed_out ) {
            return;
        }
        if ( round_is_handled ) {
            console.log( 'ERROR: tried to handle job twice (catch after handled). error: ', error );
            return;
        }
        if ( error.name == 'JobFail' || error.name == 'JobException') {
            state.job_fail_count += 1;
            state.server_fail_count = 0;
        }
        else {
            state.server_fail_count += 1;
        }
        retry( error );
    } );
}

function gearman_run_job_with_state( name, args, callback, opts, state ) {
    return proper_gearman_run_job_with_state(
        name, args, function( e, p ) { callback( p, e ); }, opts, state
    );
}

/** Send a job to gearman.
 *
 * WARNING: ARGUMENTS IN CALLBACK ARE REVERSED! RETURN VALUE FIRST, THEN ERROR.
 *
 * @param name      Gearman function name
 * @param args      Arguments for the registered function
 * @param callback  Otherwise standard callback except its arguments are
 *                  reversed in gearman_run_job_with_state() so that they
 *                  are (returnvalue, error)
 * @param opts      FIXME
 *
 * @see #gearman_run_job_with_state()
 */
function gearman_run_job( name, args, callback, opts ) {
    opts = opts || {};
    opts.servers = opts.servers || settings.get('gearman_servers');

    callback = callback || function() { return; };

    var state = {
        retry_count : 0,
        server_index : Math.floor( Math.random() * opts.servers.length ),
        server_fail_count : 0,
        job_fail_count : 0,
        last_error : '',
    };

    if ( ! isNaN( opts.retry_count ) ) {
        state.retry_count = opts.retry_count;
    }
    else if ( ! opts.background && opts.req && opts.req.method === 'GET' ) {
        state.retry_count = 2;
    }

    args = fill_and_stringify_params( args, opts );

    return gearman_run_job_with_state( name, args, callback, opts, state );
}

function gearman_run_job_bg( name, args, callback, opts ) {
    opts = opts || {};
    opts.background = true;

    return gearman_run_job( name, args, callback, opts );
}

function check_auth( req, cb ) {
    var params = {
        ip : resolve_origin_ip( req ),
        user_id : resolve_auth_user_id( req ),
        token : resolve_auth_token( req )
    };

    gearman_run_job( 'verify_token_for_user', params, function( response ) {
        cb( response.result );
    }, { req : req } );
}

function check_if_auth_user_matches_user_id( req, id, cb ) {
    if ( id === 'me' ) {
        cb( 1 );
    }
    cb( resolve_auth_user_id( req ) === id ? 1 : 0 );
}

function check_if_auth_user_matches_meeting_id( req, id, cb ) {
    var auth_user_id = resolve_auth_user_id( req );
    gearman_run_job( 'check_user_meeting_membership', { user_id : auth_user_id, meeting_id : id }, function( response ) {
        cb( response.result ? 1 : 0 );
    }, { req : req } );
}

function check_if_auth_user_matches_matchmaker_id( req, id, cb ) {
    var auth_user_id = resolve_auth_user_id( req );
    gearman_run_job( 'check_user_matchmaker_ownership', { user_id : auth_user_id, matchmaker_id : id }, function( response ) {
        cb( response.result ? 1 : 0 );
    }, { req : req } );
}

function schedule_activity_logging( req ) {
    var activity_params = {
        user_agent : req.headers['user-agent'],
        app_version : req.headers['x-meetings-app-version'],
        unmanned : req.headers['x-meetings-unmanned'],
        user_id : resolve_auth_user_id( req ),
        ip : resolve_origin_ip( req ),
        date : Math.floor( Date.now() / 1000 )
    };

    process.nextTick( function() {
        gearman_run_job_bg( 'record_user_activity', activity_params, function( result, error ) {
            if ( error ) {
                console.log( 'Error while trying to submit record_user_activity in the background: ' + error );
            }
        } );
    } );
}

function process_run_and_send_x_auth_result( err, results, req, res, opts ) {
    var send = null;
    var error = false;
    var o = opts || {};

    if ( err && err !== 'auth error' ) {
        send = [ { error : { message : err, code : 500 } } ];
        error = 500;
    }
    else if ( results.auth && results.auth_checked ) {
        if ( resolve_auth_user_id( req ) ) {
            if ( ! o.skip_activity_logging ) {
                schedule_activity_logging( req );
            }
        }

        // NOTE I don't know if and why this needs to be applied. Might it be an Arguments object?
        send = results.result;

        if ( typeof( results.result ) === 'object' ) {
            if ( typeof( results.result.error ) === 'object' ) {
                var code = parseInt(results.result.error.code, 10);
                if ( isNaN( code ) || code < 200 ) {
                    error = 500;
                }
                else {
                    error = code;
                }
            }
        }
    }
    else if ( results.auth ) {
        send = [ { error : { message : 'access denied for this object', code : 403 } } ];
        error = 403;
    }
    else {
        send = [ { error : { message : 'invalid auth', code : 401 } } ];
        error = 401;
    }

    if ( error && opts && ( opts.http_errors || ( opts.rest && req.headers['x-expect-http-errors-for-rest'] ) ) ) {
        res.status( error );
    }

    if ( req.headers['x-expect-int-epochs'] ) {
        var epoch_regex = /_epoch$/;
        traverse( send ).forEach( function( value ) {
            if ( this.isLeaf && this.key && epoch_regex.test( this.key.toString() ) ) {
                this.update( parseInt( value || 0, 10 ) );
            }
        } );
    }

    var limit_fields = req.headers['x-limit-fields'] || '';
    limit_fields = limit_fields || ( req.body ? req.body.limit_fields : '' );
    limit_fields = limit_fields || ( req.query ? req.query.limit_fields : '' );

    if ( limit_fields && _.isString( limit_fields ) ) {
        limit_fields = limit_fields.replace(/^\s*/,'');
        limit_fields = limit_fields.replace(/\s*$/,'');
        limit_fields = limit_fields.split(/\s*\,\s*/);
    }

    if ( limit_fields && _.isArray( limit_fields ) ) {

        // HOTFIX: 25.8.2015: A live version of apps were missing date_string which caused problems
        limit_fields.push('date_string');
        // This HOTFIX can be removed in 2016

        var field_map = {};
        _.each( limit_fields, function( field ) {
            var current_map = field_map;
            _.each( field.split('.'), function( key ) {
                current_map[ key ] = current_map[ key ] || {};
                current_map = current_map[ key ];
            } );
        } );

        // send is wrapped in an arguments "array" which we don't want to touch
        var multiple = _.isArray( send["0"] );
        send["0"] = traverse( send["0"] ).map( function( value ) {
            if ( this.notRoot ) {
                var path_segments = this.path;

                if ( multiple ) {
                    path_segments.shift();
                }

                var valid = false;
                var valid_maps = [ field_map ];

                _.each( path_segments, function( path_segment ) {
                    if ( valid ) {
                        return;
                    }
                    var new_valid_maps = [];
                    _.each( valid_maps, function( valid_map ) {
                        if ( valid_map[ '**' ] ) {
                            valid = true;
                        }
                        if ( valid_map[ '*' ] ) {
                            new_valid_maps.push( valid_map[ '*' ] );
                        }
                        if ( valid_map[ path_segment ] ) {
                            new_valid_maps.push( valid_map[ path_segment ] );
                        }
                    } );
                    valid_maps = new_valid_maps;
                } );

                if ( ! valid && valid_maps.length === 0 ) {
                    this.remove( true );
                }
                else if ( _.isArray( this.node ) ) {
                    // The previous this.remove() is buggy with arrays. We make sure we don't
                    // pass non-glob rules further as they would cause problems with arrays.
                    var valid_glob = false;

                    _.each( valid_maps, function( valid_map ) {
                        if ( valid_map["*"] || valid_map["**"] ) {
                            valid_glob = true;
                        }
                    } );

                    if ( ! valid_glob ) {
                        this.remove( true );
                    }
                }
            }
        } );
    }

    res.send.apply( res, send );
}

function async_handler_for_gearman_job_response( name, params, opts ) {
    return function( cb ) {
        gearman_run_job( name, params, function( result, error ) {
            cb( error, result );
        }, opts );
    };
}


function form_proper_send_cb( cb ) {
    return function() {
        cb.apply( this, [ null, arguments ] );
    };
}

function run_and_send_with_auth_using_id_check( code, id_check_code, opts ) {
    return function( req, res, next ) {
        async.auto(
            {
                auth : function(cb) { check_auth( req, function( checked ) { cb( null, checked ); } ); },
                auth_checked : function(cb) { id_check_code( req, function( checked ) { cb( null, checked ); } ); },
                result : function(cb) { code( req, res, next, form_proper_send_cb( cb ) ); }
            },
            function ( err, results ) { process_run_and_send_x_auth_result( err, results, req, res, opts ); }
        );
    };
}

function run_and_send_with_auth( code, opts ) {
    return run_and_send_with_auth_using_id_check( code, function( req, cb ) {
        cb( 1 );
    }, opts );
}

function run_and_send_with_auth_who_matches_user_id( code, opts ) {
    return run_and_send_with_auth_using_id_check( code, function( req, cb ) {
        check_if_auth_user_matches_user_id( req, resolve_param_user_id( req ), cb );
    }, opts );
}

function run_and_send_with_auth_who_matches_meeting_id( code, opts ) {
    return run_and_send_with_auth_using_id_check( code, function( req, cb ) {
        check_if_auth_user_matches_meeting_id( req, req.params.id, cb );
    }, opts );
}

function run_and_send_after_auth_using_id_check( code, id_check_code, opts ) {
    return function( req, res, next ) {
        // NOTE: If auth_checked does not depend on auth, it might fail first and report 401 when 403 should be reported
        // TODO: this could be parallelized more but the NOTE above should be taken into account
        async.auto(
            {
                auth : function(cb) { check_auth( req, function( checked ) { cb( checked ? null : 'auth error', checked ); } ); },
                auth_checked : [ 'auth', function(cb) { id_check_code( req, function( checked ) { cb( checked ? null : 'auth error', checked ); } ); } ],
                result : [ 'auth', 'auth_checked', function(cb) { code( req, res, next, form_proper_send_cb( cb ) ); } ]
            },
            function ( err, results ) { process_run_and_send_x_auth_result( err, results, req, res, opts ); }
        );
    };
}

function run_and_send( code, opts ) {
    return function( req, res, next ) {
        async.auto(
            {
                auth : function(cb) { cb( null, 1 ); },
                auth_checked : function(cb) { cb( null, 1 ); },
                result : function(cb) { code( req, res, next, form_proper_send_cb( cb ) ); }
            },
            function ( err, results ) { process_run_and_send_x_auth_result( err, results, req, res, opts ); }
        );
    };
}

function run_and_send_with_custom_security_check( code, auth_check, opts ) {
    return function( req, res, next ) {
        async.auto(
            {
                auth : function(cb) { cb( null, 1 ); },
                auth_checked : function(cb) { auth_check( req, function( checked ) { cb( checked ? null : 'security error', checked ); } ); },
                result : function(cb) { code( req, res, next, form_proper_send_cb( cb ) ); }
            },
            function ( err, results ) { process_run_and_send_x_auth_result( err, results, req, res, opts ); }
        );
    };
}

function run_and_send_after_custom_security_check( code, auth_check, opts ) {
    return function( req, res, next ) {
        async.auto(
            {
                auth : function(cb) { cb( null, 1 ); },
                auth_checked : [ 'auth', function(cb) { auth_check( req, function( checked ) { cb( checked ? null : 'security error', checked ); } ); } ],
                result : [ 'auth', 'auth_checked', function(cb) { code( req, res, next, form_proper_send_cb( cb ) ); } ]
            },
            function ( err, results ) { process_run_and_send_x_auth_result( err, results, req, res, opts ); }
        );
    };
}

function run_and_send_after_auth( code, opts ) {
    return run_and_send_after_auth_using_id_check( code, function( req, cb ) {
        cb( 1 );
    }, opts );
}

function run_and_send_after_auth_who_matches_user_id( code, opts ) {
    return run_and_send_after_auth_using_id_check( code, function( req, cb ) {
        check_if_auth_user_matches_user_id( req, resolve_param_user_id( req ), cb );
    }, opts );
}

function run_and_send_after_auth_who_matches_meeting_id( code, opts ) {
    return run_and_send_after_auth_using_id_check( code, function( req, cb ) {
        check_if_auth_user_matches_meeting_id( req, req.params.id, cb );
    }, opts );
}

function run_and_send_after_auth_who_matches_matchmaker_id( code, opts ) {
    return run_and_send_after_auth_using_id_check( code, function( req, cb ) {
        check_if_auth_user_matches_matchmaker_id( req, req.params.id, cb );
    }, opts );
}

function run_and_send_with_auth_who_matches_matchmaker_id( code, opts ) {
    return run_and_send_with_auth_using_id_check( code, function( req, cb ) {
        check_if_auth_user_matches_matchmaker_id( req, req.params.id, cb );
    }, opts );
}


/*
 * Api description.
 */
app.get('/v1', function(req, res, next) {
    res.send( 'V1 api running' );
});

app.get('/jsonp', function( req, res, next ) {
    var callback = req.query.callback || 'callback';

    var url = req.query.jsonp_url || '';
    if ( ! url || ! url.match( /^[\/]/ ) ) {
        return res.send( callback + '( ["jsonp_url missing or does not start with /"] ); ' );
    }

    var method = req.query.jsonp_method || 'GET';
    method = method.toUpperCase();

    var valid_methods = { GET : 1, POST : 1, PUT : 1, DELETE : 1 };
    if ( ! valid_methods[ method ] ) {
        return res.send( callback + '( ["invalid jsonp_method"] ); ' );
    }

    var headers = {
        'User-Agent' : req.headers['user-agent'],
        'X-Forwarded-For' : req.headers['x-forwarded-for'],
        'dic' : req.query.dic,
        'user_id' : req.query.user_id,
        'lang' : req.query.lang,
        'x-meetings-app-version' : req.query.meetings_app_version,
        'x-meetings-unmanned' : req.query.meetings_unmanned
    };

    var params = {
        url : 'http://localhost:8000' + url,
        method : method,
        headers : headers
    };

    delete req.query.jsonp_url;
    delete req.query.jsonp_method;
    delete req.query.dic;
    delete req.query.user_id;
    delete req.query.lang;
    delete req.query.meetings_app_version;
    delete req.query.meetings_unmanned;
    delete req.query.callback;

    if ( method === 'GET' || method === 'DELETE' ) {
        params.qs = req.query;
    }
    else {
        params.json = req.query;
    }

    request( params, function( error, response, body ) {
        var data = '';

        if ( error ) {
            data = { error : { code : 500, message: body } };
        }
        else if ( response && response.statusCode == 200 ) {
            if ( typeof body === 'object' ) {
                data = body;
            }
            else {
                try {
                    data = JSON.parse( body );
                }
                catch (e) {
                    data = {
                        error: { code: 500, message: e.toString() }
                    };
                }
            }
        }
        else {
            if ( response ) {
                data = { error : { code : response.statusCode, message : body } };
            }
            else {
                data = { error : { code : 500, message: body } };
            }
        }

        res.set( 'Content-Type', 'application/javascript' );
        res.send( callback + '(' + JSON.stringify( data )  + ');' );
    } );
} );

/*
 * API heartbeat
 */
app.get('/v1/heartbeat', function(req, res, next) {
    gearman_run_job('test_fg_gearman', {}, function(r, err) {
        if (err) {
            res.status(500).send(err);
        }
        else {
            res.send(r);
        }
    });
});

app.get('/v1/heartbeat_js', function(req, res, next) {
    gearman_run_job('test_js_worker', {}, function(r, err) {
        if (err) {
            res.status(500).send(err);
        }
        else {
            res.send(r);
        }
    });
});

/*
 * Gearsloth heartbeat
 */
app.get('/v1/slothbeat', function(req, res, next) {
    var job = {
        func_name: 'test_fg_gearman',
        after: 1
    };
    gearman_run_job('submitJobDelayed', job, function(r, err) {
        if (err) {
            res.status(500).send({ 'error': err });
        }
        else {
            res.send({ 'gearsloth': r });
        }
    });
});

/*
 * Public jobs
 */
app.get('/v1/public_job/:job', function(req, res, next) {
    var payload = req.payload || {};

    gearman_run_job('public_job_' + req.params.job, payload, function(r, err) {
        if ( err || ( typeof r == 'object' && r.error ) ) {
            res.status(500).send( err || r );
        }
        else {
            res.send( r );
        }
    }, { req : req, retry_count : 0, timeout : 60*1000 });
});

/*
 * Respond correctly for Firefox options call asking about X-domain stuff
 */
app.options('*', function (req, res) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Credentials', true);
    res.header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type' );
    res.writeHead(200);
    res.send();
});

/*
 * Track events
 */
app.post('/v1/track', function( req, res, next ) {
    if( ! req.body.content || ! req.body.tracking_id ) {
        res.send({'error' : 'content or tracking_id missing'});
        return;
    }

    var user_ip = resolve_origin_ip( req );

    // Check events array
    var event_parts = req.body.content.split(':');
    var event = '';

    // If we have data-track, use that
    if( event_parts[0] ) {
        event = event_parts[0];
    }
    else {
        var event_key = req.body.content;

        if( _.isUndefined(events_arr.event_key) ) {
            return res.send({ result : 'not tracked, new event'});
        }
        if( _.isEmpty(events_arr.event_key) ) {
            return res.send({ result : 'not tracked, event not described'});
        }
        event = events_arr[event_key];
    }

    var now = Math.floor( Date.now() / 1000 );
    var ago = parseInt( req.body.seconds_ago, 10 );

    var query = {
        epoch : isNaN( ago ) ? now: now - ago,
        ip : user_ip,
        user_id : req.body.user_id || '',
        session_id : req.body.tracking_id || '',
        event : event,
        title : req.body.title,
        location : req.body.location,
        referrer : req.body.referrer,
        initial_referrer : req.body.initial_referrer,
        user_agent : req.body.user_agent,
        extra_params : req.body.extra_params
    };

    gearman_run_job( 'add_trail', query, function( response ) {
        res.send({'success' : true});
    }, { req : req });
});


/*
 * Platform code for finding meet me pages
 */

app.get('/platform/v1/meetme', function( req, res, next ) {
    gearman_run_job( 'meetme_list', {
            app_id : req.query.app_id,
            match : req.query.match,
            preload : req.query.preload
        },
        function( response ) {
            if ( response === '404' ) {
                res.send( response );
            }
            else {
                var callback = req.query.callback || 'callback';
                res.setHeader('content-type', 'application/javascript');
                res.send( callback + '(' + JSON.stringify(response) + ');' );
            }
        }, { req : req }
    );
} );

app.get('/platform/v1/meetme/:token', function( req, res, next ) {
    gearman_run_job( 'meetme_url_for_token', {
            user_token : req.params.token,
            app_id : req.query.app_id
        },
        function( response ) {
            if ( response === '404' ) {
                res.send( response );
            }
            else {
                res.setHeader('content-type', 'application/javascript');
                var callback = req.query.callback || 'callback';
                res.send( callback + '(' + JSON.stringify(response) + ');' );
            }
        }, { req : req }
    );
} );

/*
 * Client Sync
*/

function set_meeting_suggestions_for_source( params, req, send_cb ) {
    var suggestions = params.suggestions || [];
    delete params.suggestions;

    var ensured_suggestion_id_list = [];

    async.forEach(
        suggestions,
        function( suggestion_data, cb ) {
            if ( ! suggestion_data.begin_epoch ) { return cb(); }

            var fetch_query = _.extend( {}, suggestion_data, params );

            gearman_run_job( 'fetch_or_create_meeting_suggestion', fetch_query, function( gearman_response ) {
                if ( gearman_response.suggestion ) {
                    ensured_suggestion_id_list.push( gearman_response.suggestion.id );
                }
                cb();
            }, { req : req } );
        },
        function( err ) {
            if ( err ) {
                return send_cb( { error : { code : 1, message : err } } );
            }

            var trim_query = {
                suggestion_id_list : ensured_suggestion_id_list,
            };

            trim_query = _.extend( trim_query, params );

            gearman_run_job( 'trim_user_meeting_suggestions_for_source_timespan', trim_query, function( gearman_response ) {
                send_cb( { result : 1 } );
            }, { req : req } );
        }
    );
}

app.get('/v1/client_sync/settings', run_and_send_with_custom_security_check( function( req, res, next, send_cb ) {
    gearman_run_job( 'fetch_client_sync_settings', {
            api_key : req.query.api_key,
        },
        function( response ) {
            send_cb( response );
        },
        { req : req }
    );
}, function( req, cb ) {
    gearman_run_job( 'check_client_sync_credentials', {
            api_key : req.query.api_key,
            api_secret : req.query.api_secret,
        },
        function( response ) {
            cb( response );
        },
        { req : req }
    );
} ) );

app.post('/v1/client_sync/set_user_calendar', run_and_send_after_custom_security_check( function( req, res, next, send_cb ) {
    gearman_run_job( 'fetch_client_sync_user_and_source_info', {
            api_key : req.body.api_key,
            email : req.body.email,
        },
        function( user_and_source_response ) {
            if ( user_and_source_response.error ) {
                return send_cb( 500, { error : user_and_source_response.error } );
            }
            var query = {
                source_id_inside_container : req.body.calendar_id,
                source_name : req.body.calendar_name,
                source_is_primary : req.body.calendar_is_primary,
                timespan_begin_epoch : req.body.timespan_begin_epoch,
                timespan_end_epoch : req.body.timespan_end_epoch,
                suggestions : req.body.entries,
            };

            query = _.extend( query, user_and_source_response );

            set_meeting_suggestions_for_source( query, req, send_cb );
        },
        { req : req }
    );
}, function( req, cb ) {
    gearman_run_job( 'check_client_sync_credentials', {
            api_key : req.body.api_key,
            api_secret : req.body.api_secret,
        },
        function( response ) {
            cb( response );
        },
        { req : req }
    );
} ) );

app.post('/v1/client_sync/log', run_and_send_with_custom_security_check( function( req, res, next, send_cb ) {
    gearman_run_job( 'store_client_sync_log', {
            api_key : req.body.api_key,
            log : req.body.log,
        },
        function( response ) {
            send_cb( response );
        },
        { req : req }
    );
}, function( req, cb ) {
    gearman_run_job( 'check_client_sync_credentials', {
            api_key : req.body.api_key,
            api_secret : req.body.api_secret,
        },
        function( response ) {
            cb( response );
        },
        { req : req }
    );
} ) );

/*
 * Tokens
 */

app.get('/v1/beta_access_codes', function( req, res, next ) {

    res.send( {
        open_floodgates : 1,
        codes : [
            'TECHEU',
            'MEETINGS',
            'MASHABLE',
            'TECHCRUNCH',
            'ARCTICSTARTUP',
            'THENEXTWEB',
            'VENTUREBEAT',
            'LIFEHACKER',
            'GIGAOM',
            'TECHVIBES',
            'INC',
            'READWRITEWEB',
            'THEVERGE',
            'GUST',
            'SEATS2MEET',
            'ELISA',
            'KPN',
            'BASE',
            'TELIA',
            'TELIASONERA',
            'ANGELLIST',
            'FASTCOMPANY',
            'LIFEWITHTECH',
            'MOBIILI',
            'XVHZ',
        ],
    } );
} );

/*
 * Post an email, pin or fb code to get a login email
 */
app.post('/v1/login', function( req, res, next ) {
    if ( req.body.google_code ) {
        gearman_run_job( 'login_with_google_code', {
                code : req.body.google_code,
                beta : req.body.beta,
                device_type : req.body.device_type,
                time_zone: req.body.time_zone,
                redirect_uri : req.body.google_redirect_uri || ''
            },
            function( response ) {
                res.send( response );
            }, { req : req }
        );
    }
    else if ( req.body.fb_code && req.body.fb_redirect_uri ) {
        gearman_run_job( 'verify_facebook_code', {
                code : req.body.fb_code,
                beta : req.body.beta,
                device_type : req.body.device_type,
                redirect_uri : req.body.fb_redirect_uri
            },
            function( response ) {
                res.send( response );
            }, { req : req }
        );
    }
    else if ( req.body.pin ) {
        gearman_run_job( 'verify_pin_for_user', {
                user_id : req.body.user_id,
                email : req.body.email,
                phone : req.body.phone,
                pin : req.body.pin,
                beta : req.body.beta,
                device_type : req.body.device_type
            },
            function( response ) {
                res.send( response );
            }, { req : req }
        );
    }
    else if ( req.body.phone ) {
        gearman_run_job( 'request_login_sms', {
                ip : resolve_origin_ip( req ),
                phone : req.body.phone,
                tracking_id : req.body.tracking_id,
                include_pin : req.body.include_pin,
                preferred_app : req.body.preferred_app,
                allow_register : req.body.allow_register,
                return_host : req.body.return_host,
                time_zone: req.body.time_zone
            },
            function( response ) {
                res.send( response );
            }, { req : req }
        );
    }
    else {
        gearman_run_job( 'request_login_email', {
                ip : resolve_origin_ip( req ),
                email : req.body.email,
                tracking_id : req.body.tracking_id,
                include_pin : req.body.include_pin,
                preferred_app : req.body.preferred_app,
                allow_register : req.body.allow_register,
                return_host : req.body.return_host,
                time_zone: req.body.time_zone
            },
            function( response ) {
                res.send( response );
            }, { req : req }
        );
    }
});

var pusher = new Pusher( settings.get('pusher_config') );

app.post('/v1/pusher_auth', run_and_send_after_auth( function( req, res, next, send_cb ) {
    var channel = req.body.channel_name;
    var auth = pusher.authenticate( req.body.socket_id, channel );
    var user_matches = /meetings_user_(\d+)/.exec( channel );

    if ( user_matches && user_matches[1] ) {
        if ( resolve_auth_user_id( req ) == user_matches[1] ) {
            return send_cb( auth );
        }
    }

    return send_cb( 400 );
}, { skip_activity_logging : 1 } ) );

app.post('/v1/pusher_new_suggestions_test', run_and_send_after_auth( function( req, res, next, send_cb ) {
    pusher.trigger( 'private-meetings_user_' + resolve_auth_user_id( req ), 'new_suggestions', {} );
    return send_cb( { ok : 1 } );
} ) );

app.post('/v1/pusher_scheduling_time_found_test', run_and_send_after_auth( function( req, res, next, send_cb ) {
    pusher.trigger( 'private-meetings_user_' + resolve_auth_user_id( req ), 'scheduling_time_found', {} );
    return send_cb( { ok : 1 } );
} ) );


/*
 * Meetings
 */

function fill_responded_participants_count_for_meeting( meeting ) {
    var responded_participants_count = 0;
    _.each( meeting.participants, function( participant ) {
        if ( ! participant.unanswered_proposal_count ) {
            responded_participants_count = responded_participants_count + 1;
        }
    } );
    meeting.responded_participants_count = responded_participants_count;
}

function fetch_full_meeting_data_for_user( meeting_id, user_id, image_size, return_cb, req ) {
    async.parallel( {
        data : async_handler_for_gearman_job_response( 'fetch_meeting_basic_data', {
            user_id : user_id,
            meeting_id : meeting_id
        }, { req : req } ),
        extra_data : async_handler_for_gearman_job_response( 'fetch_meeting_extra_data', {
            user_id : user_id,
            meeting_id : meeting_id
        }, { req : req } ),
        scheduling_response : async_handler_for_gearman_job_response( 'fetch_meeting_current_scheduling', {
            user_id : user_id,
            meeting_id : meeting_id
        }, { req : req } ),
        participants_response : async_handler_for_gearman_job_response( 'fetch_meeting_participants', {
            user_id : user_id,
            meeting_id : meeting_id,
            image_size : image_size
        }, { req : req } ),
        materials_response : async_handler_for_gearman_job_response( 'fetch_meeting_materials', {
            user_id : user_id,
            meeting_id : meeting_id
        }, { req : req } )
    }, function( err, results ) {
        var meeting = results.data;

        _.extend( meeting, results.participants_response, results.materials_response, results.extra_data, results.scheduling_response );

        fill_responded_participants_count_for_meeting( meeting );

        return_cb( meeting );
    } );
}

/*
 * Create a meeting
 */

app.post('/v1/meetings', run_and_send_after_auth( function( req, res, next, send_cb ) {
    var query;

    var auth_user_id = resolve_auth_user_id( req );

    if ( req.body.from_suggestion_id ) {
        query = {
            user_id : resolve_auth_user_id( req ),
            suggestion_id : req.body.from_suggestion_id
        };
        gearman_run_job( 'activate_suggestion', query, function( response ) {
            return fetch_full_meeting_data_for_user( response.id, auth_user_id, -1, send_cb, req );
        }, { req : req });
    }
    else {
        query = {
            user_id : resolve_auth_user_id( req ),

            location : req.body.location_value || req.body.location,
            title : req.body.title_value || req.body.title,
            background_theme : req.body.background_theme,
            background_image_url : req.body.background_image_url,
            background_upload_id : req.body.background_upload_id,
            meeting_type : req.body.meeting_type,
            online_conferencing_option : req.body.online_conferencing_option,
            online_conferencing_data : req.body.online_conferencing_data,
            skype_account : req.body.skype_account,
            initial_agenda : req.body.initial_agenda,
            begin_date : req.body.begin_date,
            end_date : req.body.end_date,
            begin_time : req.body.begin_time,
            end_time : req.body.end_time,
            begin_epoch : req.body.begin_epoch,
            end_epoch : req.body.end_epoch
        };

        gearman_run_job( 'create_meeting', query, function( response ) {
            if ( ! response.id ) {
                return send_cb( 500 );
            }
            if ( req.body.participants ) {
                async.each(
                    req.body.participants,
                    function( participant_data, cb ) {
                        var p_query = {
                            meeting_id : response.id,
                            by_user_id : auth_user_id,
                            image_size : -1,
                            email : participant_data.email,
                            phone : participant_data.phone,
                            name : participant_data.name,
                            user_id : participant_data.user_id,
                            require_rsvp : participant_data.require_rsvp,
                        };
                        gearman_run_job( 'add_meeting_participant', p_query, function( response ) {
                            cb( null, response );
                        }, { req : req });
                    },
                    function( error, results ) {
                        return fetch_full_meeting_data_for_user( response.id, auth_user_id, -1, send_cb, req );
                    }
                );
            }
            else {
                return fetch_full_meeting_data_for_user( response.id, auth_user_id, -1, send_cb, req );
            }
        }, { req : req });
    }
} ) );

/*
 * Get info, update or delete single meeting
 */
app.get('/v1/meetings/:id', run_and_send_with_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var image_size = req.query.image_size || 50;
    var meeting_id = req.params.id;
    var user_id = resolve_auth_user_id( req );

    return fetch_full_meeting_data_for_user( meeting_id, user_id, image_size, send_cb, req );
}, { rest : 1 } ) );


/*
 * Save meeting related data, and weirdly save selected time proposal for now
 * TODO: put in place a proper security check as now all meeting participants can edit
 */
app.put('/v1/meetings/:id', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var image_size = req.query.image_size || 50;
    var user_id = resolve_auth_user_id( req );
    var meeting_id = req.params.id;

    // Deprecated but here for backwards compatibility
    if ( req.body.chosen_proposal_id ) {
        var query_deprecated = {
            meeting_id : meeting_id,
            user_id : user_id,
            proposal_id : req.body.chosen_proposal_id
        };

        gearman_run_job( 'choose_proposal', query_deprecated, function( response ) {
            send_cb( response );
        }, { req : req });
    }
    else {
        var query = {
            meeting_id : meeting_id,
            user_id : user_id,

            location : req.body.location_value,
            title : req.body.title_value || req.body.title,
            background_theme : req.body.background_theme,
            background_image_url : req.body.background_image_url,
            background_upload_id : req.body.background_upload_id,
            meeting_type : req.body.meeting_type,
            online_conferencing_option : req.body.online_conferencing_option,
            online_conferencing_data : req.body.online_conferencing_data,
            skype_account : req.body.skype_account,
            begin_date : req.body.begin_date,
            end_date : req.body.end_date,
            begin_time : req.body.begin_time,
            end_time : req.body.end_time,
            begin_epoch : req.body.begin_epoch,
            end_epoch : req.body.end_epoch,
            matchmaking_accepted : req.body.matchmaking_accepted,
            require_rsvp_again : req.body.require_rsvp_again,
            settings : req.body.settings
        };

        gearman_run_job( 'update_meeting', query, function( response ) {
            if ( response.id ) {
                fetch_full_meeting_data_for_user( meeting_id, user_id, image_size, send_cb, req );
            }
            else {
                send_cb( 500 );
            }
        }, { req : req });
    }
} ) );

// TODO: proper security checking
app.delete('/v1/meetings/:id', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        user_id : resolve_auth_user_id( req )
    };

    gearman_run_job( 'delete_meeting', query, function( response ) {
        send_cb( response );
    }, { req : req });
} ) );

// TODO: proper security checking
app.post('/v1/meetings/:id/cancel', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        user_id : resolve_auth_user_id( req ),
        cancel_message : req.body.cancel_message
    };

    gearman_run_job( 'cancel_meeting', query, function( response ) {
        send_cb( response );
    }, { req : req });
} ) );

// TODO: proper security checking
app.post('/v1/meetings/:id/matchmaking_decline', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        user_id : resolve_auth_user_id( req ),
        decline_message : req.body.decline_message
    };

    gearman_run_job( 'decline_meeting', query, function( response ) {
        send_cb( response );
    }, { req : req });
} ) );

/*
 * Get user list for a meeting
 */
app.get('/v1/meetings/:id/participants', run_and_send_with_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var image_size = req.query.image_size || 120;
    var query = {
        meeting_id : req.params.id,
        image_size : image_size
    };
    gearman_run_job( 'fetch_meeting_participants', query, function( response ) {
        send_cb( response.participants );
    }, { req : req });
}, { rest : 1 } ) );

/*
 * Add users to a meeting
 */
app.post('/v1/meetings/:id/participants', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        email : req.body.email,
        phone : req.body.phone,
        name : req.body.name,
        user_id : req.body.user_id,
        greeting_subject : req.body.greeting_subject,
        greeting_message : req.body.greeting_message,
        require_rsvp : req.body.require_rsvp,
        scheduling_disabled : req.body.scheduling_disabled,

        meeting_id : req.params.id,
        by_user_id : resolve_auth_user_id( req ),
        image_size : req.body.image_size || 120
    };

    gearman_run_job( 'add_meeting_participant', query, function( response ) {
        send_cb( response );
    }, { req : req });
} ) );


app.post('/v1/meetings/:id/register_hangout_data', run_and_send( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        user_id : req.body.user_id,
        token : req.body.token,
        user_count : req.body.user_count,
        hangout_uri : req.body.hangout_uri
    };

    gearman_run_job( 'register_meeting_hangout_data', query, function( response ) {
        send_cb( response );
    }, { req : req });
} ) ) ;

/*
 * Invite draft participants
 */
app.post('/v1/meetings/:id/send_draft_participant_invites', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        greeting_subject : req.body.greeting_subject,
        greeting_message : req.body.greeting_message,
        agenda : req.body.agenda,
        title : req.body.title,
        require_rsvp : req.body.require_rsvp,

        meeting_id : req.params.id,
        by_user_id : resolve_auth_user_id( req ),
        image_size : req.body.image_size || 120
    };

    gearman_run_job( 'send_draft_participant_invites', query, function( response ) {
        send_cb( response );
    }, { req : req });
} ) );


/*
 * DEPRECATED
 * Get info, update or delete participant in a meeting
 */
app.get('/v1/meetings/:id/participants/:pid', run_and_send_with_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var meeting_id = req.params.id;
    var user_id = req.params.pid;
    var image_size = req.query.image_size || 200;
    gearman_run_job( 'fetch_meeting_participant_data', { meeting_id : meeting_id, user_id : user_id, image_size : image_size }, function( gearman_response ) {
        send_cb( gearman_response );
    }, { req : req });
}, { rest : 1 } ) );

function auth_id_check_for_participant( req, cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    check_if_auth_user_matches_meeting_id( req, meeting_id, cb );
}

app.get('/v1/meeting_participants/:id', run_and_send_with_auth_using_id_check( function( req, res, next, send_cb ) {
    var image_size = req.query.image_size || 200;
    var query = { id : req.params.id, image_size : image_size };
    gearman_run_job( 'fetch_meeting_participant_object_data', query , function( gearman_response ) {
        send_cb( gearman_response );
    }, { req : req });
}, auth_id_check_for_participant, { rest : 1 } ) );

app.delete('/v1/meeting_participants/:id', run_and_send( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var query = {
        meeting_id : params[0],
        participant_id : req.params.id,
        by_user_id : resolve_auth_user_id( req )
    };
    gearman_run_job( 'delete_meeting_participant', query, function( response ) {
        if ( response && response.result ) {
            send_cb( response.result );
        }
        else {
            send_cb( 500 );
        }
    }, { req : req });
} ) );

/*
 * Store user info
 */

// Deprecated
app.put('/v1/meetings/:id/participants/:pid', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    // Handle rsvp data
    var rsvp_data = req.body.rsvp || '';

    // Handle proposal data
    var proposal_data = req.body.proposal_answers || [];

    var query = { meeting_id : req.params.id, user_id : req.params.pid, rsvp : rsvp_data, proposal_answers : proposal_data };

    gearman_run_job( 'store_meeting_participant_data', query, function( meeting_response ) {
        send_cb( meeting_response );
    }, { req : req });
} ) );

app.put('/v1/meeting_participants/:id', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    // Handle rsvp data
    var rsvp_data = req.body.rsvp || '';

    // Handle proposal data
    var proposal_data = req.body.proposal_answers || [];

    var query = { id : req.params.id, rsvp : rsvp_data, proposal_answers : proposal_data  };

    gearman_run_job( 'store_meeting_participant_object_data', query , function( gearman_response ) {
        send_cb( gearman_response );
    }, { req : req });
}, auth_id_check_for_participant ) );

app.post('/v1/meeting_participants/:id/resend_invitation', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    gearman_run_job( 'resend_meeting_participant_invitation', { id : req.params.id } , function( gearman_response ) {
        send_cb( gearman_response );
    }, { req : req });
}, auth_id_check_for_participant ) );

app.post('/v1/meeting_participants/:id/disable_scheduling', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    gearman_run_job( 'disable_meeting_participant_scheduling', { id : req.params.id } , function( gearman_response ) {
        send_cb( gearman_response );
    }, { req : req });
}, auth_id_check_for_participant ) );

app.post('/v1/meeting_participants/:id/enable_scheduling', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    gearman_run_job( 'enable_meeting_participant_scheduling', { id : req.params.id } , function( gearman_response ) {
        send_cb( gearman_response );
    }, { req : req });
}, auth_id_check_for_participant ) );

/*
 * Add a material to meeting or a get a list of meeting materials
 */
app.get('/v1/meetings/:id/materials', run_and_send_with_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = { meeting_id : req.params.id };
    gearman_run_job( 'fetch_meeting_materials', query, function( response ) {
        send_cb( response.materials );
    }, { req : req });
}, { rest : 1 } ) );

app.post('/v1/meetings/:id/materials', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        user_id : resolve_auth_user_id( req ),
        meeting_id : req.params.id,
        upload_id : req.body.upload_id,
        material_name : req.body.material_name
    };
    gearman_run_job( 'add_meeting_material', query, function( response ) {
        gearman_run_job( 'fetch_meeting_material_data', {
            meeting_id : req.params.id,
            user_id : resolve_auth_user_id( req ),
            material_id : response.material_id
        },
        function( response ) {
            // Hack for making ols code work. Can be removed after backbone codes have been updated
            response.result = {};
            send_cb( response );
        }, { req : req } );
    }, { req : req } );
}));

/*
 * Helpers
 *
 * Helper to send a file to box api
 */

app.post('/v1/helper_box_com_api_upload', run_and_send( function( req, res, next, send_cb ) {
    var upload_url = 'https://upload.box.com/api/2.0/files/content';

    var formData = {
        attributes : req.body.attributes,
        file : {
            value: fs.createReadStream(req.files.file.path),
            options: {
                filename: req.files.file.name,
                contentType: req.files.file.type,
            }
        }
    };
    request.post({
        url: upload_url,
        headers : { 'Authorization' : req.body.authorization },
        formData: formData
    }, function(err, httpResponse, body) {
        if ( err ) {
            console.log('Box upload storing failed');
            console.log( err );
            console.log( httpResponse );
            return send_cb( {
              error : { code : 503, message : 'Storing attachment failed' }
            } );
        }

        send_cb( { result : { http : httpResponse, body : body } } );
    } );
} ) );

app.post('/v1/helper_box_com_api_get', run_and_send( function( req, res, next, send_cb ) {
    var p = JSON.parse( req.body.params );

    if ( p.url.indexOf('https://api.box.com') != 0 && p.url.indexOf('https://view-api.box.com') != 0 ) {
        return send_cb( { error : { code : 111, message : 'not a box api domain' } } );
    }

    request( p, function( err, httpResponse, body ) {
        if ( err ) {
            return send_cb( { error : { code : 112, info : err } } );
        }
        return send_cb( { result : { http : httpResponse, body : body } } );
    } );
} ) );

/*
 * Uploads
 *
 * Add a material to meeting or a get a list of meeting materials
 */

app.post('/v1/uploads', run_and_send( function( req, res, next, send_cb ) {

    var filename = req.files.file.name || 'unknown';
    filename = filename.replace( /(\"|\\|\/|\;)/g, "" ); ///// VIM:: "))
    filename = filename.replace( /^ +/g, "" );

    var formData = {
      no_thumbnail: 1
    };

    if ( req.body.create_thumbnail ) {
      formData = {
        width: req.body.width || '',
        height: req.body.height || '',
        max_width: req.body.max_width || '',
        max_height: req.body.max_height || '',
      };
    }

    formData.preview_image = req.body.preview_image || '';

    formData.Filedata = {
      value: fs.createReadStream(req.files.file.path),
      options: {
        filename: filename,
        contentType: req.files.file.type,
      }
    };

    request.post({
      url: settings.get('attachment_store_url'),
      formData: formData
    }, function(err, httpResponse, body) {
        if ( err ) {
            console.log('Attachment storing failed');
            console.log( err );
            console.log( httpResponse );
            return send_cb( {
                error : { code : 503, message : 'Storing attachment failed' }
            } );
        }

        var response, result;
        try {
            response = JSON.parse( body );
        }
        catch (e) {
            return send_cb( {
                error : { code : 500, message : e.toString() }
            } );
        }

        if ( response.hasOwnProperty('draft_id') ) {
            result = { 'upload_id' : response.draft_id };
        }
        else {
            return send_cb( {
                error : { code : 500, message : 'No draft_id in response' }
            } );
        }

        if ( response.draft_thumbnail_url ) {
            result.upload_thumbnail_url = response.draft_thumbnail_url;
        }

        if ( response.draft_preview_image_url ) {
            result.upload_preview_url = response.draft_preview_image_url;
        }

        // Without this IE9 uploader downloads things and IE8 uploader just fails
        if ( req.body.broken_ie == 1 ) {
            res.setHeader('Content-Type', 'text/html');
        }

        // this can just run in the background
        fs.unlink( req.files.file.path, function ( err ) {
            if ( err ) {
                console.log('Attachment removing failed for ' + req.files.file.path );
            }
        });

        send_cb( { result : result } );
    } );
} ) );


/*
 * Users
 */

app.get('/v1/users', function( req, res, next ) {
    var image_size = req.query.image_size || 50;
    var query = {};

    if ( req.query.user_fragment ) {
        query = { user_fragment : req.query.user_fragment, image_size : image_size };
        gearman_run_job( 'fetch_user_info_using_matchmaker_fragment', query, function( gearman_response ) {
            if ( gearman_response.user_info ) {
                res.send( gearman_response.user_info );
            }
            else {
                res.send( 404 );
            }
        }, { req : req } );
    }
    else if ( req.query.email || req.query.phone ) {
        var send_info_function = function( _req, _res, _next, send_cb ) {
            query = { email : req.query.email, phone : req.query.phone, image_size : image_size, auth_user_id : resolve_auth_user_id( req ) };
            gearman_run_job( 'fetch_user_info_using_email_or_phone', query, function( gearman_response ) {
                if ( gearman_response.user_info ) {
                    if ( resolve_auth_user_id( req ) ) {
                        send_cb( gearman_response.user_info );
                    }
                    else {
                        send_cb( { id : gearman_response.user_info.id } );
                    }
                }
                else {
                    send_cb( 404 );
                }
            }, { req : req } );
        };

        if ( resolve_auth_user_id( req ) ) {
            run_and_send_with_auth( send_info_function, { rest : 1 } )( req, res, next );
        }
        else {
            run_and_send( send_info_function, { rest : 1 } )( req, res, next );
        }
    }
    else {
        res.send( 404 );
    }
} );

app.get('/v1/users/:id', run_and_send_with_auth( function( req, res, next, send_cb ) {

    var auth_user_id = resolve_auth_user_id( req );
    var target_user_id = resolve_param_user_id( req );
    var image_size = req.query.image_size || 50;
    var query;

    if ( target_user_id === 'me' || target_user_id === auth_user_id ) {
        query = { user_id : auth_user_id, image_size : image_size, for_self : 1 };
        gearman_run_job( 'fetch_user_info', query, function( gearman_response ) {
            if ( gearman_response.user_info ) {
                if ( gearman_response.user_info.ongoing_scheduling_id ) {
                    gearman_run_job( 'fetch_scheduling_data', { scheduling_id : gearman_response.user_info.ongoing_scheduling_id }, function( response ) {
                        gearman_response.user_info.ongoing_scheduling = response;
                        send_cb( gearman_response.user_info );
                    }, { req : req } );
                }
                else {
                    send_cb( gearman_response.user_info );
                }
            }
            else {
                send_cb( gearman_response );
            }
        }, { req : req } );
    }
    else {
        query = { user_id : auth_user_id, image_size : image_size, target_user_id : target_user_id };
        async.parallel( {
            permission_check : function(perm_cb) {
                async.some(['check_common_lock','check_common_meeting'], function(task, check_cb) {
                    gearman_run_job( task, query, function( gearman_response ) {
                        check_cb(gearman_response ? true : false);
                    }, { req : req } );

                }, function(has_permission) {
                    perm_cb(null, has_permission);
                });
            },
            user_data : async_handler_for_gearman_job_response( 'fetch_user_info', { user_id : target_user_id, image_size : image_size }, { req : req } )
        }, function( err, results ) {
            // TODO: actually implement the checks and enable this afterwards
            if( results.permission_check && false ) {
                send_cb( results.user_data.user_info );
            }
            else {
                send_cb( 401 );
            }
        } );
    }

}, { rest : 1 } ) );

app.post('/v1/users', run_and_send( function( req, res, next, send_cb ) {

    // Primary email & matchmaker lock id required
    if ( req.body.matchmaker_lock_id && req.body.primary_email ) {
        var query = {
            primary_email : req.body.primary_email,
            matchmaker_lock_id : req.body.matchmaker_lock_id,
            first_name : req.body.first_name,
            last_name : req.body.last_name,
            phone : req.body.phone,
            skype : req.body.skype,
            organization : req.body.organization,
            linkedin : req.body.linkedin,
            upload_id : req.body.upload_id,
            language : req.body.language,
            timezone : req.body.timezone,
            title :req.body.organization_title || req.body.title, // Deprecated
            organization_title : req.body.organization_title || req.body.title,
            tos_accepted : '1'
        };

        gearman_run_job( 'create_user_for_matchmaker_lock', query, function( gearman_response ) {
            if ( gearman_response.user_info ) {
                send_cb( gearman_response.user_info );
            }
            else {
                send_cb( gearman_response );
            }
        }, { req : req } );
    }
    else {
        send_cb( { error : { code : 401 } } );
    }
} ) );

function form_user_update_query( req ) {

    return  {
        user_id : resolve_auth_user_id( req ),
        primary_email : req.body.primary_email,
        primary_phone : req.body.primary_phone,

        name : req.body.name,
        first_name : req.body.first_name,
        last_name : req.body.last_name,
        phone : req.body.phone,
        skype : req.body.skype,
        organization : req.body.organization,
        title :req.body.organization_title || req.body.title, // Deprecated
        organization_title : req.body.organization_title || req.body.title,
        linkedin : req.body.linkedin,
        upload_id : req.body.upload_id,
        timezone : req.body.time_zone || req.body.timezone, // deprecated
        time_zone : req.body.time_zone || req.body.timezone,
        time_display : req.body.time_display,
        tos_accepted : req.body.tos_accepted,
        password : req.body.password,
        language : req.body.language,

        google_code : req.body.google_code,
        google_redirect_uri : req.body.google_redirect_uri,

        meetme_fragment : req.body.meetme_fragment,
        meetme_description : req.body.meetme_description,
        meetme_background_upload_id : req.body.meetme_background_upload_id,
        meetme_background_image_url : req.body.meetme_background_image_url,
        meetme_background_theme : req.body.meetme_background_theme,
        meetme_order : req.body.meetme_order,

        custom_theme : req.body.custom_theme,
        custom_background_upload_id : req.body.custom_background_upload_id,
        custom_header_upload_id : req.body.custom_header_upload_id,

        hidden_sources : req.body.hidden_sources,
        source_settings : req.body.source_settings,

        feature_requests : req.body.feature_requests,

        patch : req.body.patch,

        image_size : req.body.image_size || 50,
        for_self : 1
    };
}

app.post('/v1/users/:id', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {

    var query = form_user_update_query( req );

    query.patch = "1";

    gearman_run_job( 'update_user_info', query, function( gearman_response ) {
        if ( gearman_response.user_info ) {
            send_cb( gearman_response.user_info );
        }
        else {
            send_cb( gearman_response );
        }
    }, { req : req } );
} ) );

app.put('/v1/users/:id', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {

    var query = form_user_update_query( req );

    gearman_run_job( 'update_user_info', query, function( gearman_response ) {
        if ( gearman_response.user_info ) {
            send_cb( gearman_response.user_info );
        }
        else {
            send_cb( gearman_response );
        }
    }, { req : req } );
} ) );

app.delete('/v1/users/:id', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var query = { user_id : resolve_auth_user_id( req ) };

    gearman_run_job( 'remove_user_account', query, function( gearman_response ) {
        send_cb( gearman_response );
    }, { req : req } );
} ) );

function send_meetings_data_filled_with_listing_data( meetings, user_id, image_size, send_cb, req ) {
    if ( ! meetings ) {
        return send_cb( [] );
    }

    async.each( meetings,
        function( meeting, cb ) {
            var parallel_jobs = {
                participants_response : async_handler_for_gearman_job_response( 'fetch_meeting_participants', {
                    meeting_id : meeting.id, image_size : image_size
                }, { req : req } ),
                extra_data_response : async_handler_for_gearman_job_response( 'fetch_meeting_listing_data', {
                    meeting_id : meeting.id, user_id : user_id
                }, { req : req } ),
            };

            if ( meeting.no_basic_data ) {
                parallel_jobs.basic_data_response = async_handler_for_gearman_job_response( 'fetch_meeting_basic_data', {
                    meeting_id : meeting.id, user_id : user_id
                }, { req : req } );
            }

            async.parallel( parallel_jobs,
                function( err, results ) {
                    if ( results.basic_data_response ) {
                        _.extend( meeting, results.basic_data_response );
                    }

                    _.extend( meeting, results.participants_response, results.extra_data_response );

                    fill_responded_participants_count_for_meeting( meeting );
                    cb();
                }
            );
        },
        function(err) {
            send_cb( meetings );
        }
    );
}

/*
 * Get users meetings and update users meeting
 */
app.get('/v1/users/:id/meetings', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var image_size = req.query.image_size || 50;

    async.waterfall( [
        async_handler_for_gearman_job_response( 'fetch_light_dated_meeting_list', {
            user_id : resolve_param_user_id( req ),
            limit : req.query.limit || 10,
            offset : req.query.offset || 0,
            start_min : req.query.start_min || '',
            start_max : req.query.start_max || '',
            sort : req.query.sort || 'desc',
            include_draft : req.query.include_draft || 0
        }, { req : req } )
    ], function( err, response ) {
        send_meetings_data_filled_with_listing_data( response.meetings, resolve_param_user_id( req ), image_size, send_cb, req );
    } );
}, { rest : 1 } ) );

var _highlight_handler = run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    async.waterfall( [
        async_handler_for_gearman_job_response( 'fetch_possibly_highlighted_meeting_list', {
            user_id : resolve_param_user_id( req )
        }, { req : req } )
    ], function( err, response ) {
        if ( ! response || ! response.meetings ) {
            return send_cb( [] );
        }
        async.forEach(
            response.meetings,
            function( meeting, cb ) {
                gearman_run_job( 'fetch_meeting_highlight_data', { meeting_id : meeting.id, user_id : req.params.id }, function( gearman_response ) {
                    meeting.highlight = gearman_response;
                    cb();
                }, { req : req });
            },
            function(err) {
                response.meetings = _.filter( response.meetings, function(o) {
                    return ( o && o.highlight && o.highlight.type && o.highlight.type !== 'none' ) ? true : false;
                });
                send_cb( response.meetings );
            }
        );
    } );
}, { rest : 1 } );

app.get('/v1/users/:id/highlighted_meetings', _highlight_handler );
app.get('/v1/users/:id/highlights', _highlight_handler ); /// DEPRECATED

app.get('/v1/users/:id/quickbar_meetings', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    gearman_run_job( 'fetch_quickbar_meeting_list', { "user_id" : resolve_param_user_id( req ) }, function( gearman_response ) {
        if ( gearman_response.quickbar_meetings ) {
            res.send( gearman_response.quickbar_meetings );
        }
        else {
            res.send( 500 );
        }
    }, { req : req } );
} ) );

/*
 * Get users meetings and update users meeting
 */
app.get('/v1/users/:id/unscheduled_meetings', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {

    var image_size = req.query.image_size || 50;

    async.waterfall( [
        async_handler_for_gearman_job_response( 'fetch_unscheduled_meeting_list', {
            user_id : resolve_param_user_id( req ),
            include_draft : req.query.include_draft,
            limit : req.query.limit || 10,
            offset : req.query.offset || 0,
            sort : req.query.sort || 'desc'
        }, { req : req } )
    ], function( err, response ) {

        // Filter
        if( req.query.scheduling_on ) {
            response.meetings = _.filter( response.meetings, function(o) {
                return ( o.proposals && o.proposals.length > 0 ) ? true : false;
            });
        }

        var threemonth = Math.floor( Date.now() / 1000 ) - 60*60*24*90;
        response.meetings = _.filter( response.meetings, function(o) {
            if ( parseInt( o.created_epoch, 10 ) > threemonth ) { return true; }
            if ( o.proposals && o.proposals.length > 0 ) { return true; }
            return false;
        });

        send_meetings_data_filled_with_listing_data( response.meetings, resolve_param_user_id( req ), image_size, send_cb, req );
    } );
}, { rest : 1 } ) );

var _user_suggestion_handler = run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var image_size = req.query.image_size || 50;

    async.waterfall( [
        async_handler_for_gearman_job_response( 'fetch_active_meeting_suggestion_list', {
            user_id : resolve_param_user_id( req ),
            limit : req.query.limit || 10,
            offset : req.query.offset || 0,
            force_reload : req.query.force_reload || 0,
            start_min : req.query.start_min || '',
            start_max : req.query.start_max || '',
            sort : req.query.sort || 'desc',
            include_draft : req.query.include_draft || 0
        }, { req : req } )
    ], function( err, response ) {
        if ( ! response || ! response.suggestions ) {
            return send_cb( [] );
        }
        async.forEach(
            response.suggestions,
            function( suggestion, cb ) {
                gearman_run_job( 'fetch_suggestion_participants', { suggestion_id :suggestion.id, image_size : image_size }, function( gearman_response ) {
                    suggestion.participants = gearman_response.participants;
                    cb();
                }, { req : req });
            },
            function(err) {
                send_cb( response.suggestions );
            }
        );
    } );
}, { rest : 1 } );

app.get('/v1/users/:id/suggested_meetings', _user_suggestion_handler );
app.get('/v1/users/:id/meeting_suggestions', _user_suggestion_handler ); /// DEPRECATED

app.post('/v1/users/:id/suggested_meetings/batch_insert', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var suggestions = [];
    var user_id = resolve_auth_user_id( req );

    try {
        suggestions = JSON.parse( req.body.batch );
    }
    catch (e) {
        console.log('ERROR: failed to parse json in suggested_meetings/batch_insert');
        suggestions = [];
    }

    async.forEach(
        suggestions,
        function( suggestion_data, cb ) {
            if ( ! suggestion_data.begin_epoch ) {
                return cb();
            }

            suggestion_data.user_id = user_id;
            gearman_run_job( 'ensure_meeting_suggestion_exists', suggestion_data, function( gearman_response ) {
                cb();
            }, { req : req });
        },
        function(err) {
            send_cb( { result : 1 } );
        }
    );
} ) );

app.post('/v1/users/:id/suggested_meetings/set_for_source_batch', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    set_meeting_suggestions_for_source( {
        user_id : resolve_auth_user_id( req ),
        source_container_id : req.body.source_container_id,
        source_container_type : req.body.source_container_type,
        source_container_name : req.body.source_container_name,
        source_id_inside_container : req.body.source_id_inside_container,
        source_name : req.body.source_name,
        source_is_primary : req.body.source_is_primary,
        timespan_begin_epoch : req.body.timespan_begin_epoch,
        timespan_end_epoch : req.body.timespan_end_epoch,
        suggestions : req.body.suggestions,
    }, req, send_cb );
} ) );

app.get('/v1/users/:id/meetings_and_suggestions', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var image_size = req.query.image_size || 50;

    async.parallel( {
        meetings : function( root_cb ) {
            async.waterfall( [
                async_handler_for_gearman_job_response( 'fetch_dated_meeting_list', {
                    user_id : resolve_param_user_id( req ),
                    limit : req.query.limit || 10,
                    offset : req.query.offset || 0,
                    start_min : req.query.start_min || '',
                    start_max : req.query.start_max || '',
                    sort : req.query.sort || 'desc',
                    include_draft : req.query.include_draft || 0
                }, { req : req } )
            ], function( err, response ) {
                send_meetings_data_filled_with_listing_data( response.meetings, resolve_param_user_id( req ), image_size, function( meetings ) {
                    root_cb( null, meetings );
                }, req );
            } );
        },
        suggestions : function( root_cb ) {
            async.waterfall( [
                async_handler_for_gearman_job_response( 'fetch_active_meeting_suggestion_list', {
                    user_id : req.params.id,
                    limit : req.query.limit || 10,
                    offset : req.query.offset || 0,
                    force_reload : req.query.force_reload || 0,
                    start_min : req.query.start_min || '',
                    /// Hack to get one months worth of google stuff:
                    start_max : parseInt(req.query.start_min, 10) + 60*60*24*30,
                    sort : req.query.sort || 'desc',
                    include_draft : req.query.include_draft || 0
                }, { req : req } )
            ], function( err, response ) {
                async.forEach(
                    response.suggestions,
                    function( suggestion, cb ) {
                        var query = { suggestion_id :suggestion.id, image_size : image_size };
                        gearman_run_job( 'fetch_suggestion_participants', query, function( gearman_response ) {
                            suggestion.participants = gearman_response.participants;
                            cb();
                        }, { req : req });
                    },
                    function(err) {
                        root_cb( null, response.suggestions );
                    }
                );
            } );
        }
    }, function( error, data ) {
        var combined = data.meetings.concat( data.suggestions );
        combined = _.sortBy( combined, function( meeting ) { return meeting.begin_epoch; } );
        send_cb( combined );
    } );
} ) );

app.post('/v1/users/:id/connect_google_code', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'user_connect_google_code', {
            user_id : user_id,
            code : req.body.google_code,
            redirect_uri : req.body.google_redirect_uri || ''
        },
        function( response ) {
            res.send( response );
        }, { req : req }
    );
} ) );

app.post('/v1/users/:id/start_trial', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'user_start_trial', {
            user_id : user_id,
            code : req.body.trial_code
        },
        function( response ) {
            res.send( response );
        }, { req : req }
    );
} ) );

app.post('/v1/users/:id/start_free_trial', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'user_start_free_trial', {
            user_id : user_id,
        },
        function( response ) {
            if ( response && response.result ) {
                res.send( response.result );
            }
            if ( response && response.error ) {
                res.send( response );
            }
            else {
                res.send( 500 );
            }
        }, { req : req }
    );
} ) );

app.post('/v1/users/:id/send_pro_features_email', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'send_pro_features_email', {
            user_id : user_id,
        },
        function( response ) {
            if ( response && response.result ) {
                res.send( response.result );
            }
            if ( response && response.error ) {
                res.send( response );
            }
            else {
                res.send( 500 );
            }
        }, { req : req }
    );
} ) );

app.post('/v1/users/:id/confirm_email', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'user_confirm_email', {
            user_id : user_id,
            ip : resolve_origin_ip( req ),
            include_pin : req.body.include_pin,
            email : req.body.email
        },
        function( response ) {
            res.send( response );
        }, { req : req }
    );
} ) );

app.post('/v1/users/:id/confirm_phone', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'user_confirm_phone', {
            user_id : user_id,
            ip : resolve_origin_ip( req ),
            include_pin : req.body.include_pin,
            phone : req.body.phone
        },
        function( response ) {
            res.send( response );
        }, { req : req }
    );
} ) );

app.post('/v1/users/:id/send_app_sms', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'user_send_app_sms', {
            user_id : user_id,
        },
        function( response ) {
            res.send( response );
        }, { req : req }
    );
} ) );

/*
 * Get users news
 */
app.get('/v1/users/:id/news', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var url = 'https://meetings-gapier.appspot.com/fetch?worksheet_token=meetingsnews:scivzgkuzlpgblcj';
    var auth_user_id = resolve_auth_user_id( req );

    async.parallel(
        {
            user : async_handler_for_gearman_job_response(
                'fetch_user_info',
                { user_id : auth_user_id, for_self : 1 },
                { req : req }
            ),
            news : function(cb) {
                request(url, function (error, response, body) {
                    cb(null, body || []);
                });
            }
        },
        function( err, results ) {
            var news = [];
            var dismissed = results.user.user_info.dismissed_news || [];

            try {
                news = JSON.parse(results.news);
            }
            catch (e) {
                console.log('failed to parse news JSON');
                news = [];
            }

            var filtered_news = _.filter( news, function(o) {
                var a = dismissed.indexOf(o.uniqueid) === -1;
                var b = (! o.disabled || o.disabled === '0');
                return a && b;
            });

            send_cb( filtered_news || []);
        }
    );
}));

/*
 * Delete news aka mark news as dismissed
 */
app.delete('/v1/users/:id/news/:nid', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var auth_user_id = resolve_auth_user_id( req );

    async.waterfall( [
        async_handler_for_gearman_job_response( 'fetch_user_info', {
        user_id : auth_user_id,
        for_self : 1
    }, { req : req } )
    ], function( err, response ) {

        var dismissed_news = response.user_info.dismissed_news || [];

        if( ! req.params.nid  ) {
            send_cb(400);
            return;
        }

        if( dismissed_news.indexOf(req.params.nid) === -1 ) {
            dismissed_news.push(req.params.nid);
        }

        var query = {
            patch : 1,
            user_id : auth_user_id,
            dismissed_news : dismissed_news
        };

        gearman_run_job( 'update_user_info', query, function( gearman_response ) {
            if ( gearman_response.user_info ) {
                send_cb( gearman_response.user_info );
            }
            else {
                send_cb( gearman_response );
            }
        }, { req : req } );
    } );
} ) );


/*
 * Suggestions
 */

var _suggestion_handler = run_and_send_after_auth( function( req, res, next, send_cb ) {
    if ( ! req.body.disabled ) {
        return send_cb( { success : 1, message : "not changing anything" } );
    }

    var query = {
        suggestion_id : req.params.id,
        disabled : 1,
        auth_user_id : resolve_auth_user_id( req )
    };

    gearman_run_job( 'disable_meeting_suggestion', query, function( response ) {
        send_cb( response );
    }, { req : req });
} );

app.put('/v1/suggested_meetings/:id', _suggestion_handler );
app.put('/v1/meeting_suggestions/:id', _suggestion_handler ); /// DEPRECATED


/*
 * Materials
 */

function auth_id_check_for_material( req, cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    check_if_auth_user_matches_meeting_id( req, meeting_id, cb );
}

function auth_id_check_for_material_edit( req, cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    check_if_auth_user_matches_meeting_id( req, meeting_id, cb );
}

/*
 * Get single material
 */
var _materials_handler = run_and_send_with_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var user_id = resolve_auth_user_id( req );
    var query = { material_id : req.params.id, meeting_id : meeting_id, user_id : user_id };
    gearman_run_job( 'fetch_meeting_material_data', query, function( response ) {
        send_cb( response );
    }, { req : req });
}, auth_id_check_for_material, { rest : 1 } );

app.get('/v1/meeting_materials/:id', _materials_handler );
app.get('/v1/materials/:id', _materials_handler ); /// DEPRECATED, UNDOCUMENTED

/*
 * Get comments for material
 */
var _material_comments_get_handler = run_and_send_with_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var image_size = req.query.image_size || 60;
    var query = { material_id : req.params.id, meeting_id : meeting_id, image_size : image_size };
    gearman_run_job( 'fetch_meeting_material_comments', query, function( response ) {
        send_cb( response.comments );
    }, { req : req });
}, auth_id_check_for_material, { rest : 1 } );

app.get('/v1/meeting_materials/:id/comments', _material_comments_get_handler );
app.get('/v1/materials/:id/comments', _material_comments_get_handler ); /// DEPRECATED, UNDOCUMENTED

/*
 * Add comment for material
 */
var _material_comments_post_handler = run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var content = req.body.content || "";
    var user_id = resolve_auth_user_id( req );
    var image_size = req.body.image_size || 60;
    var query = { meeting_id : meeting_id, material_id : req.params.id, user_id : user_id, content : content };
    gearman_run_job( 'add_meeting_material_comment', query, function( response ) {
        gearman_run_job( 'fetch_single_meeting_material_comment', {
            meeting_id : meeting_id,
            image_size : image_size,
            material_id : req.params.id,
            comment_id : response.comment_id,
        },
        function( response ) {
            send_cb( response );
        }, { req : req } );
    }, { req : req });
}, auth_id_check_for_material );

app.post('/v1/materials/:id/comments', _material_comments_post_handler );
app.post('/v1/meeting_materials/:id/comments', _material_comments_post_handler );

app.delete('/v1/meeting_materials/:mid/comments/:id', run_and_send( function( req, res, next, send_cb ) {
    var params = req.params.mid.split(':');
    var query = {
        meeting_id : params[0],
        material_id : req.params.mid,
        comment_id : req.params.id,
        user_id : resolve_auth_user_id( req )
    };
    gearman_run_job( 'delete_meeting_material_comment', query, function( response ) {
        if ( response && response.result ) {
            send_cb( response.result );
        }
        else {
            send_cb( 500 );
        }
    }, { req : req });
} ) );

app.delete('/v1/meeting_materials/:id', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var query = {
        meeting_id : meeting_id,
        material_id : req.params.id,
        user_id : resolve_auth_user_id( req )
    };

    gearman_run_job( 'delete_meeting_material', query, function( response ) {
        send_cb( response );
    }, { req : req });
}, auth_id_check_for_material  ) );


/*
 * Edits
 */

app.put('/v1/meeting_materials/:id', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var user_id = resolve_auth_user_id( req );
    var query;

    if ( req.body.edit_id ) {
        query = {
            meeting_id : meeting_id,
            material_id : req.params.id,
            user_id : user_id,
            edit_id : req.body.edit_id,
            content : req.body.content,
            old_content : req.body.old_content
        };

        gearman_run_job( 'store_wiki_edit', query, function( response ) {
            if ( response.result && response.result.success ) {
                gearman_run_job( 'fetch_meeting_material_data', { user_id : user_id, material_id : req.params.id, meeting_id : meeting_id }, function( response ) {
                    send_cb( response );
                }, { req : req });
            }
            else {
                send_cb( { error : { code : 1, message : '?' } } );
            }
        }, { req : req });
    }
    else {
        query = {
            meeting_id : meeting_id,
            material_id : req.params.id,
            user_id : user_id,
            title : req.body.title
        };
        gearman_run_job( 'rename_material', query, function( response ) {
            if ( response && response.success ) {
                gearman_run_job( 'fetch_meeting_material_data', { user_id : user_id, material_id : req.params.id, meeting_id : meeting_id }, function( response ) {
                    send_cb( response );
                }, { req : req });
            }
            else {
                send_cb( { error : { code : 2, message : 'renaming meeting failed', response: response } } );
            }
        }, { req : req });
    }

}, auth_id_check_for_material ) );

app.get('/v1/meeting_materials/:id/edits', run_and_send_with_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var user_id = resolve_auth_user_id( req );
    var query = { meeting_id : meeting_id, material_id : req.params.id, user_id : user_id };
    gearman_run_job( 'get_wiki_edit', query, function( response ) {
         send_cb( response );
    }, { req : req });
}, auth_id_check_for_material, { rest : 1 } ) );

app.post('/v1/meeting_materials/:id/edits', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var user_id = resolve_auth_user_id( req );
    var query = { meeting_id : meeting_id, material_id : req.params.id, user_id : user_id };
    gearman_run_job( 'start_wiki_edit', query, function( response ) {
         send_cb( response );
    }, { req : req });
}, auth_id_check_for_material ) );

app.post('/v1/meeting_materials/:id/continue_edit', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var user_id = resolve_auth_user_id( req );
    var query = { meeting_id : meeting_id, material_id : req.params.id, user_id : user_id };
    gearman_run_job( 'continue_wiki_edit', query, function( response ) {
         send_cb( response );
    }, { req : req });
}, auth_id_check_for_material ) );

app.put('/v1/meeting_material_edits/:id', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var page_id = params[1];
    var lock_id = params[2];
    var user_id = resolve_auth_user_id( req );
    var query = { meeting_id : meeting_id, page_id : page_id, lock_id : lock_id, user_id : user_id, content : req.body.content };
    gearman_run_job( 'refresh_wiki_edit', query, function( response ) {
         send_cb( response );
    }, { req : req });
}, auth_id_check_for_material_edit ) );

app.delete('/v1/meeting_material_edits/:id', run_and_send_after_auth_using_id_check( function( req, res, next, send_cb ) {
    var params = req.params.id.split(':');
    var meeting_id = params[0];
    var page_id = params[1];
    var lock_id = params[2];
    var user_id = resolve_auth_user_id( req );
    var query = { meeting_id : meeting_id, page_id : page_id, lock_id : lock_id, user_id : user_id };
    gearman_run_job( 'cancel_wiki_edit', query, function( response ) {
         send_cb( response );
    }, { req : req });
}, auth_id_check_for_material_edit ) );


/*
 * Events
 */

app.get('/v1/matchmaking_events/:id', run_and_send( function( req, res, next, send_cb ) {
    var query = { event_id : req.params.id };
    gearman_run_job( 'fetch_matchmaking_event', query, function( gearman_response ) {
        if ( gearman_response.matchmaking_event ) {
            send_cb( gearman_response.matchmaking_event );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
} ) );

app.get('/v1/matchmaking_events/:id/registrations', run_and_send( function( req, res, next, send_cb ) {
    var query = { event_id : req.params.id };
     async.parallel(
        {
            registrations : async_handler_for_gearman_job_response( 'fetch_matchmaking_event_registration_infos_map', query, { req : req } ),
            matchmakers : async_handler_for_gearman_job_response( 'fetch_matchmaking_event_registration_matchmakers_map', query, { req : req } )
        },
        function( err, results ) {
            if ( ! err && results.registrations && results.matchmakers ) {
                var registrations = [];

                _.forEach( _.keys( results.registrations.infos_map ), function( email ) {
                    var info = results.registrations.infos_map[ email ] || {};
                    var matchmaker = results.matchmakers.links_map[ email ] || {};

                    // Clean both of empty
                    _.forEach( _.keys( info ), function( k ) {
                        if ( info[k] === null ) {
                            delete info[k];
                        }
                    });
                    _.forEach( _.keys( matchmaker ), function( k ) {
                        if ( matchmaker[k] === null ) {
                            delete matchmaker[k];
                        }
                    });


                    var result =  _.extend( {}, info, matchmaker );

                    delete result.email;

                    registrations.push( result );
                });

                send_cb( registrations );
            }
            else {
                send_cb( 503 );
            }
        }
    );
} ) );


/*
 * Matchmakers
 */

app.get('/v1/matchmakers/:id', run_and_send( function( req, res, next, send_cb ) {
    var query = { matchmaker_id : req.params.id };
    gearman_run_job( 'fetch_matchmaker', query, function( gearman_response ) {
        if ( gearman_response.matchmaker ) {
            send_cb( gearman_response.matchmaker );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
}, { rest : 1 } ) );

app.delete('/v1/matchmakers/:id', run_and_send_after_auth_who_matches_matchmaker_id( function( req, res, next, send_cb ) {
    var query = { matchmaker_id : req.params.id, user_id : resolve_auth_user_id( req ) };
    console.log('with query: ', query);
    gearman_run_job( 'delete_matchmaker', query, function( gearman_response ) {
        console.log(gearman_response);
        if ( gearman_response.result ) {
            send_cb( gearman_response );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
} ) );

app.get('/v1/users/:id/matchmakers', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    gearman_run_job( 'fetch_user_matchmakers', { user_id : resolve_param_user_id( req ) }, function( gearman_response ) {
        send_cb( gearman_response.matchmakers );
    }, { req : req } );
}, { rest : 1 } ) );

app.get('/v1/matchmakers', run_and_send( function( req, res, next, send_cb ) {
    var query = { user_fragment : req.query.user_fragment, matchmaker_fragment : req.query.matchmaker_fragment };
    gearman_run_job( 'fetch_matchmakers_filtered_by_fragments', query, function( gearman_response ) {
        if ( gearman_response.matchmakers ) {
            send_cb( gearman_response.matchmakers );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
}, { rest : 1 } ) );

var matchmaker_params_query = function( req ) {
    return {
        partner_id : req.body.partner_id,
        user_id : resolve_auth_user_id( req ),
        matchmaking_event_id : req.body.matchmaking_event_id,
        description : req.body.description,
        location : req.body.location,
        background_theme : req.body.background_theme,
        background_upload_id : req.body.background_upload_id,
        duration : req.body.duration,
        planning_buffer : req.body.planning_buffer,
        preset_agenda : req.body.preset_agenda,
        ask_reason : req.body.ask_reason,
        suggest_reason : req.body.suggest_reason,
        confirm_automatically : req.body.confirm_automatically,
        preset_title : req.body.preset_title,
        preset_materials : req.body.preset_materials,
        buffer : req.body.buffer,
        time_zone : req.body.time_zone || req.body.timezone,
        background_image_url : req.body.background_image_url,
        available_timespans : req.body.available_timespans,
        source_settings : req.body.source_settings,
        name : req.body.name,
        vanity_url_path : req.body.vanity_url_path,
        youtube_url : req.body.youtube_url,
        slots : req.body.slots,
        direct_link_enabled : req.body.direct_link_enabled,
        meeting_type : req.body.meeting_type,
        meetme_hidden : req.body.meetme_hidden,
        online_conferencing_option : req.body.online_conferencing_option,
        online_conferencing_data : req.body.online_conferencing_data,
        organizer_swiping_required : req.body.organizer_swiping_required,
        require_verified_user : req.body.require_verified_user
    };
};

var matchmaker_create_handler = run_and_send_after_auth( function( req, res, next, send_cb ) {
    gearman_run_job( 'create_user_matchmaker', matchmaker_params_query( req ), function( gearman_response ) {
        if ( gearman_response.matchmaker ) {
            send_cb( gearman_response.matchmaker );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
} );

app.post('/v1/matchmakers', matchmaker_create_handler );
app.post('/v1/users/:not_used/matchmakers', matchmaker_create_handler );


var matchmaker_update_handler = run_and_send_after_auth_who_matches_matchmaker_id( function( req, res, next, send_cb ) {
    var query = matchmaker_params_query( req );
    query.matchmaker_id = req.params.id;

    gearman_run_job( 'update_user_matchmaker', query, function( gearman_response ) {
        if ( gearman_response.matchmaker ) {
            send_cb( gearman_response.matchmaker );
        }
        else {
            send_cb( gearman_response );
        }
    }, { req : req } );
} );

app.put('/v1/matchmakers/:id', matchmaker_update_handler );
app.put('/v1/users/:not_used/matchmakers/:id', matchmaker_update_handler );

app.get('/v1/matchmakers/:id/options', run_and_send( function( req, res, next, send_cb ) {
    var query = { matchmaker_id : req.params.id, begin_epoch : req.query.begin_epoch, end_epoch : req.query.end_epoch };
    gearman_run_job( 'fetch_matchmaker_options', query, function( gearman_response ) {
        if ( gearman_response.options ) {
            send_cb( gearman_response.options );
        }
        else if ( gearman_response.error ) {
            send_cb( 404 );
        }
        else {
            send_cb( [] );
        }
    }, { req : req } );
}, { rest : 1 } ) );

app.post('/v1/users/:id/preview_matchmaker_options', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var query = {
        user_id : resolve_auth_user_id( req ),
        slots : req.body.slots,
        available_timespans : req.body.available_timespans,
        source_settings : req.body.source_settings,
        matchmaking_event_id : req.body.matchmaking_event_id,
        buffer : req.body.buffer,
        planning_buffer : req.body.planning_buffer,
        time_zone : req.body.time_zone,
        begin_epoch : req.body.begin_epoch,
        end_epoch : req.body.end_epoch
    };
    gearman_run_job( 'preview_matchmaker_options', query, function( gearman_response ) {
        if ( gearman_response.options ) {
            send_cb( gearman_response.options );
        }
        else if ( gearman_response.error ) {
            send_cb( 404 );
        }
        else {
            send_cb( [] );
        }
    }, { req : req } );
} ) );

var create_lock = function( orig_req, orig_res, orig_next ) {

    var create_function = function( req, res, next, send_cb ) {
        var query = {
            user_id : resolve_auth_user_id( req ) || 0,
            matchmaker_id : req.params.id || req.body.matchmaker_id,
            extended_lock : req.body.extended_lock,
            location : req.body.location,
            rescheduled_meeting_id : req.body.rescheduled_meeting_id,
            start_epoch : req.body.start_epoch,
            end_epoch : req.body.end_epoch
        };

        gearman_run_job( 'create_matchmaker_lock', query, function( gearman_response ) {
            if ( gearman_response ) {
                send_cb( gearman_response );
            }
            else {
                send_cb( 503 );
            }
        }, { req : req } );
    };

    if ( resolve_auth_user_id( orig_req ) ) {
        run_and_send_after_auth( create_function )( orig_req, orig_res, orig_next );
    }
    else {
        run_and_send( create_function )( orig_req, orig_res, orig_next );
    }
};

app.post('/v1/matchmakers/:id/locks', create_lock );
app.post('/v1/matchmaker_locks', create_lock );

app.get('/v1/matchmaker_locks/:id', function( orig_req, orig_res, orig_next ) {
    var cancel_function = function( req, res, next, send_cb ) {
        var query = {
            user_id : resolve_auth_user_id( req ) || 0,
            lock_id : req.params.id
        };

        gearman_run_job( 'get_matchmaker_lock', query, function( gearman_response ) {
            if ( gearman_response ) {
                send_cb( gearman_response );
            }
            else {
                send_cb( 503 );
            }
        }, { req : req } );
    };

    if ( resolve_auth_user_id( orig_req ) ) {
        run_and_send_after_auth( cancel_function, { rest : 1 } )( orig_req, orig_res, orig_next );
    }
    else {
        run_and_send( cancel_function, { rest : 1 } )( orig_req, orig_res, orig_next );
    }
} );

app.delete('/v1/matchmaker_locks/:id', function( orig_req, orig_res, orig_next ) {

    var cancel_function = function( req, res, next, send_cb ) {
        var query = {
            user_id : resolve_auth_user_id( req ) || 0,
            lock_id : req.params.id
        };

        gearman_run_job( 'cancel_matchmaker_lock', query, function( gearman_response ) {
            if ( gearman_response ) {
                send_cb( gearman_response );
            }
            else {
                send_cb( 503 );
            }
        }, { req : req } );
    };

    if ( resolve_auth_user_id( orig_req ) ) {
        run_and_send_after_auth( cancel_function )( orig_req, orig_res, orig_next );
    }
    else {
        run_and_send( cancel_function )( orig_req, orig_res, orig_next );
    }
} );

app.put('/v1/matchmaker_locks/:id', function( orig_req, orig_res, orig_next ) {

    var confirm_function = function( req, res, next, send_cb ) {
        var query = {
            user_id : resolve_auth_user_id( req ),
            lock_id : req.params.id,
            quickmeet_key : req.body.quickmeet_key,
            extra_data : req.body.extra_data,
            location : req.body.location,
            agenda : req.body.agenda
        };

        gearman_run_job( 'confirm_matchmaker_lock', query, function( gearman_response ) {
            if ( gearman_response ) {
                send_cb( gearman_response );
            }
            else {
                send_cb( 503 );
            }
        }, { req : req } );
    };

    var send_confirm_email_function = function( req, res, next, send_cb ) {
        var query = {
            lock_id : req.params.id,
            expected_confirmer_id : req.body.expected_confirmer_id,
            quickmeet_key : req.body.quickmeet_key,
            extra_data : req.body.extra_data,
            location : req.body.location,
            agenda : req.body.agenda
        };

        gearman_run_job( 'send_matchmaker_lock_confirm_email', query, function( gearman_response ) {
            if ( gearman_response ) {
                send_cb( gearman_response );
            }
            else {
                send_cb( 503 );
            }
        }, { req : req } );
    };

    var extend_lock_function = function( req, res, next, send_cb ) {
        var query = {
            lock_id : req.params.id,
            extra_data : req.body.extra_data,
            location : req.body.location,
            agenda : req.body.agenda
        };

        gearman_run_job( 'extend_matchmaker_lock', query, function( gearman_response ) {
            if ( gearman_response ) {
                send_cb( gearman_response );
            }
            else {
                send_cb( 503 );
            }
        }, { req : req } );
    };

    var auth_user_id = resolve_auth_user_id( orig_req );

    if ( auth_user_id && ! orig_req.body.ignore_auth_user && ( ! orig_req.body.expected_confirmer_id || orig_req.body.expected_confirmer_id == auth_user_id ) ) {
        run_and_send_after_auth( confirm_function )( orig_req, orig_res, orig_next );
    }
    else if ( orig_req.body.expected_confirmer_id || orig_req.body.quickmeet_key ) {
        run_and_send( send_confirm_email_function )( orig_req, orig_res, orig_next );
    }
    else {
        run_and_send( extend_lock_function )( orig_req, orig_res, orig_next );
    }
} );

app.get('/v1/matchmakers/:id/quickmeets', run_and_send_with_auth_who_matches_matchmaker_id( function( req, res, next, send_cb ) {
    var query = { matchmaker_id : req.params.id };
    gearman_run_job( 'get_matchmaker_quickmeets', query, function( gearman_response ) {
        if ( gearman_response.quickmeets ) {
            send_cb( gearman_response.quickmeets );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
}, { rest : 1 } ) );

app.post('/v1/matchmakers/:id/quickmeets', run_and_send_after_auth_who_matches_matchmaker_id( function( req, res, next, send_cb ) {
    var query = {
        matchmaker_id : req.params.id,
        email : req.body.email,
        name : req.body.name,
        phone : req.body.phone,
        organization : req.body.organization,
        title : req.body.title,
        meeting_title : req.body.meeting_title,
        message : req.body.message
    };
    gearman_run_job( 'create_matchmaker_quickmeet', query, function( gearman_response ) {
        if ( gearman_response.quickmeet ) {
            send_cb( gearman_response.quickmeet );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
} ) );

app.post('/v1/matchmakers/:id/quickmeets/:qid/send', run_and_send_after_auth_who_matches_matchmaker_id( function( req, res, next, send_cb ) {
    var query = {
        matchmaker_id : req.params.id,
        quickmeet_id : req.params.qid
    };
    gearman_run_job( 'send_matchmaker_quickmeet', query, function( gearman_response ) {
        if ( gearman_response ) {
            send_cb( gearman_response );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
} ) );

/*
 * Meeting scheduling rounds aka. swipe2meet
 */

app.post('/v1/meetings/:id/schedulings', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {

    var query = {
        meeting_id : req.params.id,
        from_matchmaker_id : req.body.from_matchmaker_id,
        partner_id : req.body.partner_id,
        user_id : resolve_auth_user_id( req ),
        duration : req.body.duration,
        planning_buffer : req.body.planning_buffer,
        confirm_automatically : req.body.confirm_automatically,
        buffer : req.body.buffer,
        time_zone : req.body.time_zone,
        available_timespans : req.body.available_timespans,
        source_settings : req.body.source_settings,
        slots : req.body.slots,
        online_conferencing_option : req.body.online_conferencing_option,
        online_conferencing_data : req.body.online_conferencing_data,
        organizer_swiping_required : req.body.organizer_swiping_required
    };
    gearman_run_job( 'create_meeting_scheduling', query, function( gearman_response ) {
        if ( gearman_response ) {
            send_cb( gearman_response );
        }
        else {
            send_cb( 500 );
        }
    }, { req : req } );
} ) );

app.get('/v1/meetings/:id/schedulings/:sid', run_and_send_with_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        scheduling_id : req.params.sid,
        image_size : req.query.image_size || -1,
        user_id : resolve_auth_user_id( req ),
        direct_api_fetch : 1,
    };
    gearman_run_job( 'fetch_scheduling_data', query, function( gearman_response ) {
        if ( gearman_response ) {
            send_cb( gearman_response );
        }
        else {
            send_cb( 500 );
        }
    }, { req : req } );
} ) );

// Remember to _not_ use nested objects inside parameter objects as they won't be automatically deep cloned!

var log_entry_templates = {
    suggestion_accepted : { msg : '%1$s accepted: %2$s', params : [ { type : 'user' }, { type : 'timestamp', display_hint : 'short', from_data_key : 'suggestion_epoch' } ] },
    suggestion_declined : { msg : '%1$s declined: %2$s', params : [ { type : 'user' }, { type : 'timestamp', display_hint : 'short', from_data_key : 'suggestion_epoch' } ] },
    suggestion_reaccepted : { msg : '%1$s changed answer: %2$s accepted', params : [ { type : 'user' }, { type : 'timestamp', display_hint : 'short', from_data_key : 'suggestion_epoch' } ] },
    suggestion_redeclined : { msg : '%1$s changed answer: %2$s declined', params : [ { type : 'user' }, { type : 'timestamp', display_hint : 'short', from_data_key : 'suggestion_epoch' } ] },
    scheduling_opened : { msg : '%1$s opened scheduling', params : [ { type : 'user' } ] },
    scheduling_created : { msg : '%1$s created scheduling', params : [ { type : 'user' } ] },
    scheduling_modified : { msg : '%1$s modified scheduling', params : [ { type : 'user' } ] },
    user_invited_sms : { msg : '%1$s invited via SMS', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_invited_push : { msg : '%1$s invited via push notification', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_invited_email : { msg : '%1$s invited via email', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_reinvited_sms : { msg : '%1$s reinvited via SMS', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_reinvited_push : { msg : '%1$s reinvited via push notification', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_reinvited_email : { msg : '%1$s reinvited via email', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_more_input_sms : { msg : '%1$s was asked for more input via SMS', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_more_input_push : { msg : '%1$s was asked for more input via push notification', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_more_input_email : { msg : '%1$s was asked for more input via email', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    organizer_input_sms : { msg : '%1$s was asked for input via SMS', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    organizer_input_push : { msg : '%1$s was asked for input via push notification', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    organizer_input_email : { msg : '%1$s was asked for input via email', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_time_found_sms : { msg : '%1$s notified of scheduled time via SMS', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_time_found_push : { msg : '%1$s notified of scheduled time via push notification', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_time_found_email : { msg : '%1$s notified of scheduled time via email', params : [ { type : 'user', from_data_key : 'user_id' } ] },
    user_added : { msg : '%1$s invited by %2$s', params : [ { type : 'user', from_data_key : 'user_id' }, { type : 'user', display_hint: 'first_name' } ] }, // Only sent if happens after scheduling_created
    user_removed : { msg : '%1$s removed by %2$s', params : [ { type : 'user', from_data_key : 'user_id' }, { type : 'user', display_hint: 'first_name' } ] },
    user_left : { msg : '%1$s left scheduling', params : [ { type : 'user' } ] },
    user_calendar : { msg : '%1$s adjusted calendar settings', params : [ { type : 'user' } ] },
    calendar_blocks_one : { msg : '%1$s Calendar event blocked a suggestion', params : [ { type : 'icon', data : 'calendar' } ] },
    calendar_blocks_multiple : { msg : '%1$s Calendar event blocked suggestions', params : [ { type : 'icon', data : 'calendar' } ] },
    calendar_unblocks_one : { msg : '%1$s Calendar changed: New suggestion available', params : [ { type : 'icon', data : 'calendar' } ] },
    calendar_unblocks_multiple : { msg : '%1$s Calendar changed: New suggestions available', params : [ { type : 'icon', data : 'calendar' } ] },
    user_state_changed : {
        template_key : 'state',
        templates : {
            invited : { msg : '%1$s moved to: Not yet answered', params : [ { type : 'user', from_data_key : 'user_id' } ] },
            availability_needed : { msg : '%1$s moved to: Availability needed', params : [ { type : 'user', from_data_key : 'user_id' } ] },
            common_time_found : { msg : '%1$s moved to: Common time found', params : [ { type : 'user', from_data_key : 'user_id' } ] },
            removed : { msg : '%1$s moved to: Removed', params : [ { type : 'user', from_data_key : 'user_id' } ] },
        },
    },
    instruction_changed : {
        template_key : 'instruction',
        templates : {
            'sending_invitations' : { msg : "We are sending the invitations. Please hold on." },
            'all_good' : { msg : "Scheduling is running smoothly. Keep track of the progress in real-time:" },
            'everyone_left': { msg : "This scheduling has no participants left. Consider rescheduling or adding someone." },
            'needs_activation': { msg : "Some participants have not answered. Consider reminding them." },
            'too_busy_people': { msg : "Finding time with everyone seems hard. Consider rescheduling or removing someone." },
            'time_found': { msg : "The time has been decided. Great!" },
        }
    },
    time_found : { msg : 'Time found: %1$s', params : [ { type : 'timestamp', display_hint : 'short', from_data_key : 'found_epoch' } ] },
    time_set_manually : {  msg : '%1$s set the time manually', params : [ { type : 'user' } ] },
    meeting_removed : {  msg : '%1$s cancelled scheduling', params : [ { type : 'user' } ] },
    suggestions_used : { msg : '%1$s All available suggestions declined', params : [ { type : 'icon', data : 'error' } ] },

    // debug entries

    user_invited_sms_clicked : { debug : 1, msg : '%1$s clicked SMS invite', params : [ { type : 'user' } ] },
    user_invited_email_clicked : { debug : 1, msg : '%1$s clicked email invite', params : [ { type : 'user' } ] },
    user_reinvited_sms_clicked : { debug : 1, msg : '%1$s clicked SMS reinvite', params : [ { type : 'user' } ] },
    user_reinvited_email_clicked : { debug : 1, msg : '%1$s clicked email reinvite', params : [ { type : 'user' } ] },
    user_more_input_sms_clicked : { debug : 1, msg : '%1$s clicked SMS more input request', params : [ { type : 'user' } ] },
    user_more_input_email_clicked : { debug : 1, msg : '%1$s clicked email more input request', params : [ { type : 'user' } ] },
    user_time_found_sms_clicked : { debug : 1, msg : '%1$s clicked SMS time found alert', params : [ { type : 'user' } ] },
    user_time_found_email_clicked : { debug : 1, msg : '%1$s clicked email time found alert', params : [ { type : 'user' } ] },
    first_scheduling_fetch : { debug : 1, msg : '%1$s fetched scheduling for the first time', params : [ { type : 'user' } ] },

};

var log_entry_param_fill_mappers = {
    user : function( param, entry, req, cb ) {
        var key = param.from_key || 'author_id';
        var data_key = param.from_data_key;
        delete param.from_key;
        delete param.from_data_key;
        gearman_run_job( 'fetch_user_info', { user_id : data_key ? entry.data[ data_key ] : entry[ key ], image_size : req.query.image_size || -1 }, function( gearman_response ) {
            param.data = gearman_response.user_info;
            cb( null, param );
        }, { req : req } );
    },
    timestamp : function( param, entry, req, cb ) {
        var key = param.from_key || 'entry_epoch';
        var data_key = param.from_data_key;
        delete param.from_key;
        delete param.from_data_key;
        param.data = { epoch : data_key ? entry.data[ data_key ] : entry[ key ] };
        cb( null, param );
    },
    icon : function( param, entry, req, cb ) {
        cb( null, param );
    },
};

var log_entry_data_fillers = {
    user_state_changed : function ( entry, req, cb ) {
        gearman_run_job( 'fetch_user_info', { user_id : entry.data.user_id, image_size : req.query.image_size || -1 }, function( gearman_response ) {
            entry.data.user = gearman_response.user_info;
            cb();
        }, { req : req } );
    },
};

var map_log_entry_in_place = function( entry, req, entry_cb ) {
    var template = log_entry_templates[ entry.entry_type ];
    var data_filler = log_entry_data_fillers[ entry.entry_type ];
    data_filler = data_filler || function( _entry, _req, _cb ) { _cb(); };

    if ( template && template.template_key && entry.data && entry.data[ template.template_key ] ) {
        template = template.templates[ entry.data[ template.template_key ] ];
    }

    if ( ! template ) {
        return entry_cb();
    }

    if ( template.debug ) {
        if ( ! req.query.debug ) {
            return entry_cb();
        }
    }

    entry.msg = template.msg;
    async.parallel( [
        function( parallel_cb ) {
            data_filler( entry, req, parallel_cb );
        },
        function( parallel_cb ) {
            async.map( template.params || [], function( param, cb ) {
                var fill_mapper = log_entry_param_fill_mappers[ param.type ];
                fill_mapper = fill_mapper || function( _param, _entry, _req, _cb ) {
                    console.err( 'Unknown parameter type: ' + param.type );
                    _cb( null, _param );
                };
                fill_mapper( _.clone( param ), entry, req, cb );
            }, function( err, results ) {
                entry.params = results;
                parallel_cb();
            } );
        },
    ], function() {
        entry_cb( null, entry );
    } );
};

app.get('/v1/meetings/:id/schedulings/:sid/log_entries', run_and_send_with_custom_security_check( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        scheduling_id : req.params.sid,
        image_size : req.query.image_size || -1,
        user_id : resolve_auth_user_id( req ),
    };
    gearman_run_job( 'fetch_scheduling_log_entries', query, function( gearman_response ) {
        if ( gearman_response ) {
            async.map( gearman_response, function ( entry, cb ) {
                if ( ( ! req.query.min_created_epoch ) || ( parseInt( req.query.min_created_epoch, 10 ) <= parseInt( entry.created_epoch, 10 ) ) ) {
                    map_log_entry_in_place( entry, req, cb );
                }
                else {
                    cb();
                }
            }, function( err, entries ) {
                if ( err ) {
                    send_cb( 500 );
                }
                else {
                    var filtered_entries = _.filter( entries, function( entry ) { return entry ? true : false; } );
                    send_cb( filtered_entries );
                }
            } );
        }
        else {
            send_cb( 500 );
        }
    }, { req : req } );
}, function( req, cb ) {
    if ( req.query.secret && md5.digest_s('suola' + req.query.secret ) === 'ebea895c8302e2bc5e4973ddd3583081' ) {
        cb( 1 );
    }
    else {
        check_auth( req, function( ok ) {
            if ( ! ok ) { return cb( 0 ); }
            check_if_auth_user_matches_meeting_id( req, req.params.id, cb );
        } );
    }
} ) );

app.get('/v1/meetings/:id/schedulings/:sid/flow', run_and_send_with_custom_security_check( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        scheduling_id : req.params.sid,
        image_size : req.query.image_size || -1,
        user_id : resolve_auth_user_id( req ),
    };

    async.parallel( {
        meeting_response : async_handler_for_gearman_job_response( 'fetch_meeting_basic_data', query, { req : req } ),
        scheduling_response : async_handler_for_gearman_job_response( 'fetch_scheduling_data', query, { req : req } ),
        options_response : async_handler_for_gearman_job_response( 'fetch_scheduling_options', query, { req : req } ),
        participants_response : async_handler_for_gearman_job_response( 'fetch_meeting_participants', query, { req : req } ),
        answers_response : async_handler_for_gearman_job_response( 'fetch_scheduling_answers', query, { req : req } ),
    }, function( err, responses ) {
        if ( err ) {
            return send_cb( 500, err );
        }

        var options = responses.options_response.options;
        var answers = responses.answers_response.answers;
        var participants = responses.participants_response.participants;
        var scheduling = responses.scheduling_response;
        var meeting = responses.meeting_response;

        answers.sort( function( a, b ) { return a.created_epoch - b.created_epoch; } );

        var options_by_id = {};
        options.forEach( function( o ) {
            options_by_id[ o.id ] = o;
        } );

        var participants_by_id = {};
        participants.forEach( function( o ) {
            participants_by_id[ o.user_id ] = o;
        } );

        var events = [];
        answers.forEach( function( a ) {
            var answer = { answer : a.answer, created_epoch : a.created_epoch };
            var p = participants_by_id[ a.user_id ];
            var o = options_by_id[ a.option_id ];
            events.push( _.extend( { type : 'answer', name : p ? p.name : 'removed ' + a.user_id, time_string : o.time_string }, answer ) );
        } );

        var initial_participant_names = [ 'S2M' ];
        var total_participant_names = [ 'S2M' ];

        participants.sort( function( a, b ) { return a.invited_epoch - b.invited_epoch; } );
        participants.forEach( function ( p ) {
            if ( p.user_id == scheduling.creator_id ) {
                return;
            }
            if ( p.invited_epoch && scheduling.completed_epoch > 0 && p.invited_epoch > scheduling.completed_epoch ) {
                return;
            }
            if ( p.invited_epoch && p.invited_epoch > parseInt( scheduling.created_epoch, 10 ) + 15 ) {
                events.push( { type : 'invite', name : p.name, created_epoch : p.invited_epoch } );
                total_participant_names.push( p.name );
            }
            else {
                initial_participant_names.push( p.name );
                total_participant_names.push( p.name );
            }
        } );

        if ( scheduling.completed_epoch > 0 ) {
            events.push( { type : 'selected', created_epoch : scheduling.completed_epoch, time_string : meeting.date_string + ' ' + meeting.time_string + ' ' + meeting.timezone_string } );
        }

        events.sort( function( a, b ) { return a.created_epoch - b.created_epoch; } );

        var log_lines = [
            'title SwipeToMeet #' + scheduling.id + ': ' + meeting.title,
            'note over ' + initial_participant_names.join(',') + ': Scheduling started',
        ];
        events.forEach( function( e ) {
            log_lines.push( 'note over ' + ( e.name || 'S2M' ) +': ' + new Date( 1000 * e.created_epoch ).toString() );
            if ( e.type === 'invite') {
                log_lines.push( 'note over ' + e.name + ': New participant' );
            }
            else if ( e.type === 'answer' ) {
                log_lines.push( e.name + ' -> S2M:' + ( ( e.answer === 'yes' ) ? ' Accepted ' : ' Declined ' ) + e.time_string );
            }
            else if ( e.type === 'selected' ) {
                log_lines.push( 'note over ' + total_participant_names.join(',') + ': Selected ' + e.time_string );
            }
        } );

        send_cb( log_lines.join( "\n" ) + "\n" );
    } );
}, function( req, cb ) {
    if ( req.query.secret && md5.digest_s('suola' + req.query.secret ) === 'ebea895c8302e2bc5e4973ddd3583081' ) {
        cb( 1 );
    }
    else {
        check_auth( req, function( ok ) {
            if ( ! ok ) { return cb( 0 ); }
            check_if_auth_user_matches_meeting_id( req, req.params.id, cb );
        } );
    }
} ) );

app.get('/v1/schedulings/debug_list', run_and_send_with_custom_security_check( function( req, res, next, send_cb ) {
    var limit = req.query.limit;
    if ( ! limit || limit > 200 ) {
        limit = 10;
    }

    gearman_run_job( 'fetch_latest_system_schedulings', { limit : limit }, function( gearman_response ) {
        async.each( gearman_response, function( scheduling, cb ) {
            scheduling.status =
                scheduling.failed_epoch > 0 ? 'failed' :
                scheduling.completed_epoch > 0 ? 'completed' :
                scheduling.cancelled_epoch > 0 ? 'cancelled' :
                scheduling.started_epoch > 0 ? 'started' :
                'created';

            async.parallel( {
                meeting_response : async_handler_for_gearman_job_response( 'fetch_meeting_basic_data', { meeting_id : scheduling.meeting_id }, { req : req } ),
                participants_response : async_handler_for_gearman_job_response( 'fetch_meeting_participants', { meeting_id : scheduling.meeting_id }, { req : req } ),
            }, function( err, responses ) {
                scheduling.meeting_title = responses.meeting_response.title;
                scheduling.participants_count = responses.participants_response.participants.length;
                // scheduling_slots_count?,
                // scheduling_slots_available_count?,
                // scheduling_users_with_connected_calendars_count?,
                cb();
            } );
        }, function() {
            send_cb( gearman_response );
        } );
    } );
}, function( req, cb ) {
    if ( req.query.secret && md5.digest_s('suola' + req.query.secret ) === 'ebea895c8302e2bc5e4973ddd3583081' ) {
        cb( 1 );
    }
    else {
        cb( 0 );
    }
} ) );

var fetch_and_fill_and_send_scheduling_options_response_for_query = function( query, req, send_cb ) {

    var auth_user_id = resolve_auth_user_id( req );
    query.image_size = req.body.image_size || 64;

    async.parallel( {
        scheduling_response : async_handler_for_gearman_job_response( 'fetch_scheduling_data', query, { req : req } ),
        options_response : async_handler_for_gearman_job_response( 'provide_next_meeting_scheduling_options', query, { req : req } ),
        participants_response : async_handler_for_gearman_job_response( 'fetch_meeting_participants', query, { req : req } ),
        answers_response : async_handler_for_gearman_job_response( 'fetch_scheduling_answers', query, { req : req } ),
    }, function( err, responses ) {
        if ( err ) {
            return send_cb( 500, err );
        }

        var options_response = responses.options_response;
        var answers = responses.answers_response.answers;
        var participants = responses.participants_response.participants;
        var scheduling = responses.scheduling_response;

        // user changing answer shows as multiple answers by user
        var option_answers_by_user = {};
        answers.forEach( function( a ) {
            option_answers_by_user[ a.option_id ] = option_answers_by_user[ a.option_id ] || {};
            option_answers_by_user[ a.option_id ][ a.user_id ] = a.answer;
        } );

        var invalid_options = {};
        answers.forEach( function( a ) {
            if ( option_answers_by_user[ a.option_id ][ a.user_id ] === 'no' ) {
                invalid_options[ a.option_id ] = true;
            }
        } );

        var answers_by_user = {};
        answers.forEach( function( a ) {
            answers_by_user[ a.user_id ] = answers_by_user[ a.user_id ] || { valid_yes_count : 0 };
            if ( option_answers_by_user[ a.option_id ][ a.user_id ] === 'yes' && ! invalid_options[ a.option_id ] ) {
                answers_by_user[ a.user_id ].valid_yes_count += 1;
            }
        } );

        // NOTE: this could be less naive :P
        var required_answers = 2;
        if ( participants.length > 2 ) {
            required_answers += Math.ceil( Math.log( participants.length - 1 ) / Math.log( 2 ) );
        }

        async.each( [ 'option', 'yes_option', 'no_option' ], function( type, cb ) {
            if ( ! options_response[ type ] ) {
                return cb();
            }

            var option = options_response[ type ];

            if ( ! option.id ) {
                return cb();
            }

            var this_required_answers = required_answers;
            // this is disabled for now because it breaks the "enough" card layout
            /*if ( type === 'yes_option' ) {
                 this_required_answers -= 1;
            }*/

            if ( answers_by_user[ auth_user_id ] && answers_by_user[ auth_user_id ].valid_yes_count >= this_required_answers ) {
                option.optional = 1;
            }
            else {
                option.optional = 0;
            }

            option.participants = [];
            participants.forEach( function( p ) {
                if ( ! scheduling.organizer_swiping_required && p.user_id == scheduling.creator_id ) {
                    option.participants.push( _.extend( { answer : 'yes' }, p ) );
                }
                else if ( p.user_id ) {
                    option_answers_by_user[ option.id ] = option_answers_by_user[ option.id ] || {};
                    option.participants.push( _.extend( { answer : option_answers_by_user[ option.id ][ p.user_id ] || '' }, p ) );
                }
            } );

            var timespan_query = {
                user_id : auth_user_id,
                begin_epoch : parseInt( option.begin_epoch || 0, 10 ) - 8*60*60,
                end_epoch : parseInt( option.end_epoch || 0, 10 ) + 8*60*60,
            };

            gearman_run_job( 'get_user_calendar_for_timespan', timespan_query, function( gearman_response ) {
                var before = [];
                var after = [];

                option.user_calendar_entries = {
                    before : before,
                    after : after,
                    connected : 0,
                };

                if ( gearman_response && gearman_response.calendar_entries ) {
                    option.user_calendar_entries.connected = 1;
                    gearman_response.calendar_entries.forEach( function( c ) {
                        if ( c.begin_epoch < option.begin_epoch ) {
                            before.push( c );
                        }
                        else {
                            after.push( c );
                        }
                    } );
                }
                cb( null );
            }, { req : req } );

        }, function( error ) {
            if ( options_response ) {
                if ( options_response.yes_option ) {
                    options_response.next_option_after_yes = options_response.yes_option;
                }
                if ( options_response.no_option ) {
                    options_response.next_option_after_no = options_response.no_option;
                }
                send_cb( options_response );
            }
            else {
                send_cb( 500 );
            }
        } );
    } );
};

app.post('/v1/meetings/:id/schedulings/:sid/options/:oid/provide_next_options', run_and_send_with_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        scheduling_id : req.params.sid,
        option_id : req.params.oid,
        parent_option_id : req.body.parent_option_id,
        parent_option_answer : req.body.parent_option_answer
    };

    fetch_and_fill_and_send_scheduling_options_response_for_query( query, req, send_cb );
}, { http_errors : 1 } ) );

app.get('/v1/meetings/:id/schedulings/:sid/options/:oid', run_and_send_with_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        scheduling_id : req.params.sid,
        option_id : req.params.oid
    };

    fetch_and_fill_and_send_scheduling_options_response_for_query( query, req, function( data ) { send_cb( data == 500 ? data : data.option ); } );
} ) );


app.post('/v1/meetings/:id/schedulings/:sid/provide_next_option', run_and_send_with_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        scheduling_id : req.params.sid
    };

    fetch_and_fill_and_send_scheduling_options_response_for_query( query, req, send_cb );
}, { http_errors : 1 } ) );

app.post('/v1/meetings/:id/schedulings/:sid/options/:oid/answers', run_and_send_after_auth_who_matches_meeting_id( function( req, res, next, send_cb ) {
    var query = {
        meeting_id : req.params.id,
        scheduling_id : req.params.sid,
        option_id : req.params.oid,
        answer : req.body.answer
    };
    gearman_run_job( 'create_meeting_scheduling_answer', query, function( gearman_response ) {
        if ( gearman_response ) {
            send_cb( gearman_response );
        }
        else {
            send_cb( 500 );
        }
    }, { req : req } );
}, { rest : 1 } ) );


/*
 * Meeting suggestion sources aka. connected calendars & phones
 */
app.get('/v1/users/:id/suggestion_sources', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var auth_user_id = resolve_auth_user_id( req );

    var query = {
        user_id : auth_user_id
    };

    gearman_run_job( 'fetch_user_suggestion_sources', query, function( gearman_response ) {
        if ( gearman_response.suggestion_sources ) {
            send_cb( gearman_response.suggestion_sources );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
}, { rest : 1 } ) );

app.post('/v1/users/:id/suggestion_sources/set_container_batch', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var auth_user_id = resolve_auth_user_id( req );
    var query = {
        user_id : auth_user_id,
        container_name : req.body.container_name,
        container_type : req.body.container_type,
        container_id : req.body.container_id,
        sources : req.body.sources
    };

    gearman_run_job( 'set_user_suggestion_sources_for_container', query, function( gearman_response ) {
        if ( gearman_response.result ) {
            send_cb( gearman_response );
        }
        else {
            send_cb( 500 );
        }
    }, { req : req } );
} ) );


function send_notification_list_filled_with_data( notifications, user_id, req, send_cb, options ) {
    async.each(
        notifications,
        function( notification, each_cb ) {
            if ( ! notification.data ) {
                notification.data = {};
            }

            var required_data = {};
            if ( notification.data.meeting_id ) {
                required_data.meeting = async_handler_for_gearman_job_response( 'fetch_meeting_basic_data', {
                    user_id : user_id,
                    meeting_id : notification.data.meeting_id
                }, { req : req } );

                if ( notification.data.material_id ) {
                    required_data.material = async_handler_for_gearman_job_response( 'fetch_meeting_material_data', {
                        user_id : user_id,
                        meeting_id : notification.data.meeting_id,
                        material_id : notification.data.material_id,
                        image_size : -1
                    }, { req : req } );
                }
                if ( notification.data.scheduling_id ) {
                    required_data.scheduling = async_handler_for_gearman_job_response( 'fetch_scheduling_data', {
                        user_id : user_id,
                        meeting_id : notification.data.meeting_id,
                        scheduling_id : notification.data.scheduling_id,
                        image_size : -1
                    }, { req : req } );
                }
            }

            if ( notification.data.author_id ) {
                required_data.author = async_handler_for_gearman_job_response( 'fetch_user_info', {
                    user_id : notification.data.author_id,
                    image_size : -1
                }, { req : req } );
            }

            if ( notification.data.user_id ) {
                required_data.user = async_handler_for_gearman_job_response( 'fetch_user_info', {
                    user_id : notification.data.user_id,
                    image_size : -1
                }, { req : req } );
            }

            async.parallel(
                required_data,
                function( err, results ) {
                    if ( results.author ) {
                        notification.data.author = results.author.user_info;
                    }
                    if ( results.user ) {
                        notification.data.user = results.user.user_info;
                    }
                    if ( results.meeting ) {
                        notification.data.meeting = results.meeting;
                    } else {
                        notification.data.meeting = {};
                    }
                    if ( results.material ) {
                        notification.data.material = results.material;
                    }
                    if ( results.scheduling ) {
                        notification.data.scheduling = results.scheduling;
                    }

                    switch(notification.type) {
                        case "decided_meeting_date":
                            notification.data.template = notification.data.meeting.begin_epoch != "0" ?
                                "Meeting time was changed to %1$s for %2$s." :
                                "Meeting time was removed from %2$s.";
                            notification.data.params = [
                                {
                                    type: "timestamp",
                                    data: {
                                        epoch: notification.data.meeting.begin_epoch
                                    },
                                    render_hint: "strong",
                                    display_hint: "long"
                                },
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "time";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "decided_meeting_location":
                            notification.data.template = "Meeting location was set to %1$s for %2$s.";
                            notification.data.params = [
                                {
                                    type: "string",
                                    data: notification.data.meeting.location_value,
                                    render_hint: "strong"
                                },
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "location";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "invited":
                            notification.data.template = "%1$s invited you to %2$s.";
                            notification.data.params = [
                                {
                                    type: "user",
                                    data: notification.data.author,
                                    render_hint: "strong",
                                    display_hint: "name"
                                },
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "meetings";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "meetme_invited":
                            notification.data.template = "%1$s accepted your request to meet.";
                            notification.data.params = [
                                {
                                    type: "user",
                                    data: notification.data.author,
                                    render_hint: "strong",
                                    display_hint: "name"
                                }
                            ];
                            notification.data.icon = "meetings";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "meetme_request":
                            notification.data.template = notification.data.author.organization ?
                                "%1$s from %2$s would like to meet you. Please respond now." :
                                "%1$s would like to meet you. Please respond now.";
                            notification.data.params = [
                                {
                                    type: "user",
                                    data: notification.data.author,
                                    render_hint: "strong",
                                    display_hint: "name"
                                },
                                {
                                    type: "string",
                                    data: notification.data.author.organization,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "meetings";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "meetme_rsvp":
                            notification.data.template = "%1$s accepted your request and wants to double check your RSVP.";
                            notification.data.params = [
                                {
                                    type: "user",
                                    data: notification.data.author,
                                    render_hint: "strong",
                                    display_hint: "name"
                                }
                            ];
                            notification.data.icon = "meetings";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "new_meeting_date":
                            notification.data.template = notification.data.meeting.begin_epoch != "0" ?
                                "Meeting time was changed to %1$s for %2$s." :
                                "Meeting time was removed from %2$s.";
                            notification.data.params = [
                                {
                                    type: "timestamp",
                                    data: {
                                        epoch: notification.data.meeting.begin_epoch
                                    },
                                    render_hint: "strong",
                                    display_hint: "long"
                                },
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "time";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "new_meeting_location":
                            notification.data.template = "Meeting location was changed to %1$s for %2$s.";
                            notification.data.params = [
                                {
                                    type: "string",
                                    data: notification.data.meeting.location_value,
                                    render_hint: "strong"
                                },
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "location";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "new_meeting_title":
                            notification.data.template = "%1$s changed the title of %2$s to %3$s.";
                            notification.data.params = [
                                {
                                    type: "user",
                                    data: notification.data.author,
                                    render_hint: "strong",
                                    display_hint: "name"
                                },
                                {
                                    type: "string",
                                    data: notification.data.old_title,
                                    render_hint: "strong"
                                },
                                {
                                    type: "string",
                                    data: notification.data.new_title,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "meetings";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "new_participant":
                            notification.data.template = "New participant: %1$s in %2$s.";
                            notification.data.params = [
                                {
                                    type: "user",
                                    data: notification.data.user,
                                    render_hint: "strong",
                                    display_hint: "name"
                                },
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "profile";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "rsvp":
                            notification.data.template = "Please respond to the invitation: %1$s.";
                            notification.data.params = [
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "error";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "scheduling_date_found":
                            notification.data.template = "Time found for %1$s on %2$s.";
                            notification.data.params = [
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                },
                                {
                                    type: "timestamp",
                                    data: {
                                        epoch: notification.data.meeting.begin_epoch
                                    },
                                    render_hint: "strong",
                                    display_hint: "long"
                                }
                            ];
                            notification.data.icon = "time";
                            notification.data.icon_color = "normal";
                            notification.action_type = "meeting";
                            break;

                        case "scheduling_date_not_found":
                            notification.data.template = "We were unable to find a suitable time for %1$s.";
                            notification.data.params = [
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "error";
                            notification.data.icon_color = "warning";
                            notification.action_type = "meeting";
                            break;


                        // Material
                        case "new_material":
                            notification.data.template = "%1$s added material %2$s in %3$s.";
                            notification.data.params = [
                                {
                                    type: "user",
                                    data: notification.data.author,
                                    render_hint: "strong",
                                    display_hint: "name"
                                },
                                {
                                    type: "string",
                                    data: notification.data.material.title || notification.data.material.title_value,
                                    render_hint: "strong"
                                },
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "material_" + notification.data.material.type_class;
                            notification.data.icon_color = "normal";
                            notification.action_type = "material";
                            break;

                        case "new_material_comment":
                            notification.data.template = "%1$s commented %2$s in %3$s.";
                            notification.data.params = [
                                {
                                    type: "user",
                                    data: notification.data.author,
                                    render_hint: "strong",
                                    display_hint: "name"
                                },
                                {
                                    type: "string",
                                    data: notification.data.material.title || notification.data.material.title_value,
                                    render_hint: "strong"
                                },
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "comment";
                            notification.data.icon_color = "normal";
                            notification.action_type = "material";
                            break;


                        // Swipe landing
                        case "more_scheduling_answers_needed":
                            notification.data.template = "We need more input from you to schedule %1$s.";
                            notification.data.params = [
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "swipe";
                            notification.data.icon_color = "normal";
                            notification.action_type = "scheduling_landing";
                            break;

                        case "organizer_scheduling_answers_needed":
                            notification.data.template = "We need input from you to schedule %1$s.";
                            notification.data.params = [
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "swipe";
                            notification.data.icon_color = "normal";
                            notification.action_type = "scheduling_landing";
                            break;

                        case "new_scheduling_answers_needed":
                            notification.data.template = "%1$s is looking for a suitable time for a meeting.";
                            notification.data.params = [
                                {
                                    type: "user",
                                    data: notification.data.author,
                                    render_hint: "strong",
                                    display_hint: "name"
                                }
                            ];
                            notification.data.icon = "swipe";
                            notification.data.icon_color = "normal";
                            notification.action_type = "scheduling_landing";
                            break;


                        // Scheduling log
                        case "scheduling_is_missing_answers":
                            notification.data.template = "Scheduling is stagnant. We are missing responses for %1$s";
                            notification.data.params = [
                                {
                                    type: "string",
                                    data: notification.data.meeting.title_value,
                                    render_hint: "strong"
                                }
                            ];
                            notification.data.icon = "error";
                            notification.data.icon_color = "warning";
                            notification.action_type = "scheduling_log";
                            break;
                    }

                    each_cb( null );
                }
            );
        },
        function( error ) {
            var valid_notifications = [];

            notifications.forEach( function(n) {
                var valid = 1;
                if ( n.data.meeting_id ) {
                    if ( ! n.data.meeting || ! n.data.meeting.id ) {
                        valid = 0;
                    }
                }
                if ( n.data.material_id ) {
                    if ( ! n.data.material || ! n.data.material.id ) {
                        valid = 0;
                    }
                }
                if ( valid ) {
                    valid_notifications.push( n );
                }
            } );

            if ( options && options.first_only ) {
                send_cb( valid_notifications[0] );
            }
            else {
                send_cb( valid_notifications );
            }
        }
    );
}

app.get('/v1/users/:id/user_payments', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {

    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'fetch_user_subscription_transactions', { user_id : user_id }, function( gearman_response ) {
        if ( gearman_response.transactions ) {
            send_cb( gearman_response.transactions );
        }
        else {
            send_cb( gearman_response );
        }
    }, { req : req } );
} ) );

app.post('/v1/users/:id/user_payments/:transaction_id/send_receipt', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {

    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'send_user_subscription_transaction_receipt', { user_id : user_id, transaction_id : req.params.transaction_id }, function( gearman_response ) {
        if ( gearman_response ) {
            send_cb( gearman_response );
        }
    }, { req : req } );
} ) );

app.get('/v1/users/:id/notifications', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {

    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'fetch_user_notifications', { user_id : user_id }, function( gearman_response ) {
        if ( gearman_response.notifications ) {
            send_notification_list_filled_with_data( gearman_response.notifications, user_id, req, send_cb );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );
}, { rest : 1 } ) );

app.get('/v1/users/:id/notifications/:nid', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'fetch_user_notification', { user_id : user_id, notification_id : req.params.nid }, function( gearman_response ) {
        if ( gearman_response.notification ) {
            send_notification_list_filled_with_data( [ gearman_response.notification ], user_id, req, send_cb, { first_only : true } );
        }
        else {
            send_cb( 404 );
        }
    }, { req : req } );

}, { rest : 1 } ) );

app.post('/v1/users/:id/notifications/mark_seen', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'mark_many_user_notifications_seen', { user_id : user_id, id_list : req.body.id_list }, function( gearman_response ) {
        if ( gearman_response && gearman_response.result ) {
            if ( gearman_response.result instanceof Array ) {
                send_notification_list_filled_with_data( gearman_response.result, user_id, req, send_cb );
            }
            else {
                send_cb( gearman_response.result );
            }
        }
        else {
            send_cb( 500 );
        }

    }, { req : req } );
} ) );

app.post('/v1/users/:id/notifications/:nid/mark_read', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'mark_user_notification_read', { user_id : user_id, notification_id : req.params.nid }, function( gearman_response ) {
        if ( gearman_response && gearman_response.result ) {
            if ( gearman_response.result instanceof Object ) {
                send_notification_list_filled_with_data( [ gearman_response.result ], user_id, req, function( list ) { send_cb( list[0] ); } );
            }
            else {
                send_cb( gearman_response.result );
            }
        }
        else {
            send_cb( 500 );
        }

    }, { req : req } );
} ) );

app.put('/v1/users/:id/notifications/:nid', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    if ( req.body.is_read ) {
        gearman_run_job( 'mark_user_notification_read', { user_id : user_id, notification_id : req.params.nid }, function( gearman_response ) {
            if ( gearman_response && gearman_response.result ) {
                if ( gearman_response.result instanceof Object ) {
                    send_notification_list_filled_with_data( [ gearman_response.result ], user_id, req, function( list ) { send_cb( list[0] ); } );
                }
                else {
                    send_cb( gearman_response.result );
                }
            }
            else {
                send_cb( 500 );
            }
        }, { req : req } );
    }
    else if ( req.body.is_seen ) {
        gearman_run_job( 'mark_many_user_notifications_seen', { user_id : user_id, id_list : [ req.params.nid ] }, function( gearman_response ) {
            if ( gearman_response && gearman_response.result ) {
            if ( gearman_response.result instanceof Array ) {
                    var found = 0;
                    gearman_response.result.forEach( function( notification ) {
                        if ( notification.id == req.params.nid ) {
                            send_notification_list_filled_with_data( [ notification ], user_id, req, function( list ) { send_cb( list[0] ); } );
                            found = 1;
                        }
                    } );
                    if ( ! found ) {
                        send_cb( 404 );
                    }
                }
                else {
                    send_cb( gearman_response.result );
                }
            }
            else {
                send_cb( 500 );
            }
        }, { req : req } );
    }
    else {
        send_cb( 400 );
    }
} ) );

app.get('/v1/users/:id/notification_settings', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'fetch_user_notification_settings', { user_id : user_id }, function( gearman_response ) {
        if ( gearman_response.settings ) {
            send_cb( gearman_response.settings );
        }
        else {
            send_cb( 500 );
        }
    }, { req : req } );
}, { rest : 1 } ) );

app.put('/v1/users/:id/notification_settings/:nid', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );

    gearman_run_job( 'set_user_notification_setting_value', { user_id : user_id, setting_id : req.params.nid, value : req.body.value }, function( gearman_response ) {
        if ( gearman_response && gearman_response.setting ) {
            send_cb( gearman_response.setting );
        }
        else {
            send_cb( 500 );
        }
    }, { req : req } );
} ) );

function generic_service_redirect( req, res, base_url, add_query ) {
    var parts = url.parse( base_url, true );

    delete parts.search;

    parts.query.dic = req.query.dic;
    parts.query.return_url = req.query.return_url;
    parts.query.cancel_url = req.query.cancel_url;

    if ( add_query ) {
        _.each( add_query, function( value, key ) {
            parts.query[ key ] = value;
        });
    }

    res.redirect( url.format( parts ) );
}

app.get('/v1/service_redirect/google_login', function( req, res, next ) {
    generic_service_redirect( req, res, settings.get('core_domain') + '/meetings_global/google_start_2/' );
} );

app.get('/v1/service_redirect/google_connect', function( req, res, next ) {
    generic_service_redirect( req, res, settings.get('core_domain') + '/meetings_global/google_start_2/', { require_refresh_token : 1 } );
} );

app.get('/v1/service_redirect/facebook_connect', function( req, res, next ) {
    generic_service_redirect( req, res, settings.get('core_domain') + '/meetings_global/facebook_start/' );
} );

function gather_subscription_params( req ) {
    return {
        token : req.body.token,
        coupon : req.body.coupon,
        type : req.body.type,
        vat_id : req.body.vat_id,
        country : req.body.country,
        company : req.body.company,
    };
}

app.post('/v1/start_subscription', run_and_send( function( req, res, next, send_cb ) {
    var params = gather_subscription_params( req );
    params.email = req.body.email;
    params.lang = req.body.lang;

    gearman_run_job( 'create_stripe_subscription_for_user_or_email', params, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.post('/v1/users/:id/start_subscription', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var params = gather_subscription_params( req );
    params.user_id = resolve_param_user_id( req );

    gearman_run_job( 'create_stripe_subscription_for_user_or_email', params, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.post('/v1/users/:id/cancel_subscription', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var params = { user_id : resolve_param_user_id( req ) };

    gearman_run_job( 'cancel_user_stripe_subscription', params, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.post('/v1/users/:id/service_accounts/:service/disconnect', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var user_id = resolve_param_user_id( req );
    var s = req.params.service;
    if ( s === 'google' || s === 'facebook' ) {
        gearman_run_job( 'disconnect_user_service_account', { user_id : user_id, service : s }, function( r ) { send_cb( r ); }, { req : req } );
    }
    else {
        send_cb( 409 );
    }
} ) );

app.post('/v1/stripe_webhook', run_and_send( function( req, res, next, send_cb ) {
    if ( ! req.body.id ) {
        return send_cb( 409 );
    }
    gearman_run_job( 'stripe_webhook', { event_id : req.body.id }, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.get('/v1/reverse_tax_applicability/:vat_id', run_and_send( function( req, res, next, send_cb ) {
    gearman_run_job( 'validate_reverse_tax_vat', { vat_id : req.params.vat_id }, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.get('/v1/coupons', run_and_send( function( req, res, next, send_cb ) {
    gearman_run_job( 'fetch_stripe_coupons', {}, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.get('/v1/agent_booking_data', run_and_send_after_auth( function( req, res, next, send_cb ) {
    gearman_run_job( 'fetch_agent_booking_data', { user_id : resolve_auth_user_id( req ) }, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.get('/v1/agent_booking_data/:area', run_and_send_after_auth( function( req, res, next, send_cb ) {
    gearman_run_job( 'fetch_agent_booking_data', { user_id : resolve_auth_user_id( req ), area : req.params.area }, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.get('/v1/agent_booking_public_data', run_and_send( function( req, res, next, send_cb ) {
    gearman_run_job( 'fetch_agent_booking_public_data', { domain_name : req.query.domain_name }, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.post('/v1/app_request', run_and_send_after_auth( function( req, res, next, send_cb ) {
    var data = {
       user_id : resolve_auth_user_id( req ),
       email : req.body.email,
       device : req.body.device,
       timestamp : new Date().toString(),
    };
    request.post( 'https://meetings-gapier.appspot.com/add_row', {
        form: {
            worksheet_token: 's2mapprequests:mbkpryeuktjlsbrw',
            match_json : JSON.stringify( data ),
        }
    }, function (error, response, body) {
        if ( error || response.statusCode != 200) {
            console.log( "failed to insert app request", data );
        }
        send_cb( 200 );
    } );
} ) );

app.get('/v1/users/:id/meeting_contacts', run_and_send_with_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var params = { user_id : resolve_param_user_id( req ) };

    gearman_run_job( 'user_meeting_contacts', params, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.post('/v1/users/:id/send_test_push_notification', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var params = {
        user_id : resolve_param_user_id( req ),
        beta : req.body.beta,
        device_type : req.body.device_type,
        device_id : req.body.device_id,
        registration_id : req.body.registration_id,
        user_agent : req.headers['user-agent'],
    };

    gearman_run_job( 'send_user_test_push_notification', params, function( r ) { send_cb( r ); }, { req : req } );
} ) );

app.post('/v1/users/:id/set_device_push_status', run_and_send_after_auth_who_matches_user_id( function( req, res, next, send_cb ) {
    var params = {
        user_id : resolve_param_user_id( req ),
        beta : req.body.beta,
        device_type : req.body.device_type,
        device_id : req.body.device_id,
        registration_id : req.body.registration_id,
        enabled : req.body.enabled,
    };

    gearman_run_job( 'set_user_device_push_status', params, function( r ) { send_cb( r ); }, { req : req } );
} ) );

module.exports = app;
