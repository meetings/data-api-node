/* pool.js, answering to /pool requests
 */

var fs = require('fs');
var os = require('os');

var intent = 'api';
var filename = process.env.VERSION_FILE;

module.exports = function pool(req, res, next) {
    if (!fs.existsSync(filename)) {
        res.send(503, 'File not found');
        return;
    }

    fs.readFile(filename, 'utf8', function(err, data) {
        if (err) {
            res.send(503, 'File cannot be read');
            return;
        }

        res.send(200, getPoolName() + ' ' + data);
    });
}

function getPoolName() {
    var prefix = os.hostname().split('-')[0];
    if (prefix === 'live')  prefix = 'stable';
    if (prefix === 'alpha') prefix = 'beta';
    return prefix + '-' + intent;
}
