#!/usr/bin/env nodejs

if ( process.argv[2] == '--debug' ) {
    var server = require('./meetings/app').listen(8000, function () {
        var host = server.address().address;
        var port = server.address().port;
        console.log('Debug mode running on http://%s:%s', host, port);
    } );
}
else {
    require('cluster-server')(8000, function() {
        return require('./meetings/app');
    });
}
