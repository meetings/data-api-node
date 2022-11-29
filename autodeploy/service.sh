#!/bin/sh
# service.sh, 2013-12-05 Tuomas Starck / Meetin.gs

. $DEPLOYDIR/mkrundir.sh

set_version() {
    TAG=${1:-srv}

    mkrundir

    echo " *** $TAG: Creating version file"
    git rev-parse HEAD | tee $VERSIONFILE
}

setup_service() {
    TAG=${1:-srv}

    set_version $TAG

    echo " *** $TAG: Setting up service configuration"
    install -m 0644 -p $DEPLOYDIR/$INTENT.conf /etc/init/

    echo " *** $TAG: Create configuration link"
    ln -sf settings.${RANK}.js meetings/settings.js

    echo " *** $TAG: Starting servive"
    service $INTENT restart
}
