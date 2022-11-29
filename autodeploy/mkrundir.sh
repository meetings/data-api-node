#!/bin/bash
# mkrundir.sh, 2013-12-05 Tuomas Starck / Meetin.gs

set -u

PERMUSER=nobody
PERMGROUP=nogroup

mkrundir() {
    if [ ! -e $RUNDIR ]; then
        mkdir -vp $RUNDIR
        chown -c $PERMUSER:$PERMGROUP $RUNDIR
    fi
}
