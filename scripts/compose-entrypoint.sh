#!/bin/sh
set -eu

case "${RENDAR_DATABASE_ROLE:-none}" in
  owner)
    test -r /run/rendar/bootstrap.env && test -r /run/rendar-db/owner.env || { echo "Bootstrap secrets are unavailable." >&2; exit 1; }
    . /run/rendar/bootstrap.env
    . /run/rendar-db/owner.env
    export DATABASE_URL="$MIGRATION_DATABASE_URL"
    ;;
  web)
    test -r /run/rendar/web.env || { echo "Web secrets are unavailable." >&2; exit 1; }
    . /run/rendar/web.env
    export DATABASE_URL="$RUNTIME_DATABASE_URL"
    ;;
  worker)
    test -r /run/rendar/worker.env || { echo "Worker secrets are unavailable." >&2; exit 1; }
    . /run/rendar/worker.env
    export DATABASE_URL="$WORKER_DATABASE_URL"
    ;;
  none)
    test -r /run/rendar/group.env || { echo "Group worker secrets are unavailable." >&2; exit 1; }
    . /run/rendar/group.env
    ;;
  *) echo "Unknown RENDAR_DATABASE_ROLE." >&2; exit 1 ;;
esac

exec "$@"
