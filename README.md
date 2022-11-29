
data-api-node
=============

Restfull API for accessing Meetin.gs data.

For development
---------------

Put this into your .ssh/config and ask for rights to the dev machine (from Antti):

    Host coredev
    HostKeyAlias coredev
    Hostname kivi.dicole.com
    Port 20027
    User root
    ServerAliveCountMax 3
    ServerAliveInterval 20
    LocalForward 4730 127.0.0.1:4730

Connect to dev machine for the tunnel to appear in the background. You need to have this connection open for the API to access the background workers.

    ~ # ssh -fN coredev

Clone the repo and set the development config to your current config:

    ~ # git clone git@github.com:meetings/data-api-node.git
    ~ # cd data-api-node
    data-api-node # ln -s settings.dev.js meetings/settings.js

Run npm install and start the api:

    data-api-node # npm install
    data-api-node # node data-api.js

Now you can get an authorization key for example like this:

    ~ # curl -s -d 'pin=1234' --data-urlencode 'email=demo@meetin.gs' http://localhost:8000/v1/login

After which you can send authenticated requests like this:

    ~ # curl -s -H 'dic:v1_e_4633_0_0_mNCtsuCceXYZYPL_AS4woF_tUfg' -H 'user_id:4633' http://localhost:8000/v1/users/4633/notifications

Debugging
------------

To enable debugging, you need to run the app with 0.12.x, for example by using nvm (node version manager).

After changing major versions of node, it is always good to clear the node_modules directory:

    ~ # nvm install 0.12
    ~ # nvm use 0.12
    ~ # nvm i -g node-inspector
    ~ # cd data-api-node
    data-api-node # rm -Rf node_modules
    data-api-node # npm install
    data-api-node # node-debug data-api.js --debug

The --debug switch disables multi process clustering, which makes it possible to debug the process.

When starting with the debugger, there is an automatic breakpoint in the first line. To get the server actually running and responding to requests, you need to press play in the debugger interface.

After starting the process, the Chrome browser might not open the debugger correctly. You might need to open the page manually in the browser by navigating to:

    http://127.0.0.1:8080/?ws=127.0.0.1:8080&port=5858

Installation in production
------------

1. Install dependencies and link *data-api* to your *$PATH*.
```
# npm install
# npm link
```

2. Copy *Upstart* configuration in place.
```
# install -m 0644 autodeploy/data-api.conf /etc/init
```

3. Start service.
```
# service data-api start
```
