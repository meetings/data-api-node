#!/bin/sh
# init.sh, 2013-12-05 Tuomas Starck / Meetin.gs
#
# Autodeployment (version 2) init hook for
# generic Node.js service initialization.

set -u

. $DEPLOYDIR/service.sh

echo " *** init: Initializing npm config and modules"
npm config set prefix $PREFIX --global
npm install 2> /dev/null
npm link

setup_service "init"
