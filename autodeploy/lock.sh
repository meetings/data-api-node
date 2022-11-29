#!/bin/bash
# lock.sh, 2013-12-05 Tuomas Starck / Meetin.gs
#
# Autodeployment script to ensure update is allowed
# to happen by acquiring a predefined lock file.

set -u

LOCKWAIT=4

. $DEPLOYDIR/mkrundir.sh

acquire_lock() {
    mkrundir

    # Create lock and wait is someone removes it.
    #
    touch $LOCKFILE
    sleep $LOCKWAIT

    # Do not continue, until lockfile has been acquired.
    #
    while [ ! -f $LOCKFILE ]; do
        echo " *** nolock, retrying"
        touch $LOCKFILE
        sleep $LOCKWAIT
    done
}

release_lock() {
    rm -f $LOCKFILE || true
}
