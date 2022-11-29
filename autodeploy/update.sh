#!/bin/bash
# update.sh, 2014-05-06 Tuomas Starck / Meetin.gs
#
# Autodeployment (version 2) update hook for
# generic Node.js service upgrading.

set -u

. $DEPLOYDIR/githupdate.sh
. $DEPLOYDIR/service.sh

set_version "update"

git_upgrade

if [ $? == 0 ] && [ "$FORCE" != "yes" ]; then
    echo " *** update: Version has not changed, exiting"
    exit 0
fi

. $DEPLOYDIR/lock.sh
. $DEPLOYDIR/service.sh

acquire_lock && {
    echo " *** update: Lock acquired, trying to update"
    npm update 2> /dev/null

    setup_service "update"

    release_lock
}
