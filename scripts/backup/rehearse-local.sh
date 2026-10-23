#!/usr/bin/env bash
# This harness creates and stops only its own cluster. It never uses .env or a shared DB.
set -euo pipefail
cd "$(dirname "$0")/../.."
for tool in initdb pg_ctl pg_dump pg_restore; do
  if ! "$tool" --version | grep -Eq '\(PostgreSQL\) 18\.'; then
    echo 'PostgreSQL 18 server and client binaries must be first in PATH.' >&2
    exit 1
  fi
done
CLUSTER_DIR=$(mktemp -d "${TMPDIR:-/tmp}/observatorio-30-cluster.XXXXXX")
# The OS selects a currently free loopback port. If another process wins the
# race, pg_ctl fails; the harness never stops or connects to that other process.
PORT=$(node --input-type=module -e 'import net from "node:net"; const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
initdb -D "$CLUSTER_DIR/data" -U rehearsal_owner --auth=trust --no-locale > "$CLUSTER_DIR/initdb.log"
cleanup() {
  local status=$?
  trap - EXIT
  if ! pg_ctl -D "$CLUSTER_DIR/data" -m fast -w stop > "$CLUSTER_DIR/stop.log" 2>&1; then
    echo "Check owned cluster shutdown: $CLUSTER_DIR" >&2
    status=1
  fi
  exit "$status"
}
pg_ctl -D "$CLUSTER_DIR/data" -l "$CLUSTER_DIR/server.log" -o "-h 127.0.0.1 -p $PORT -k $CLUSTER_DIR" -w start
trap cleanup EXIT
export BACKUP_STAGING_DATABASE_URL="postgres://rehearsal_owner@127.0.0.1:$PORT/postgres"
export BACKUP_REHEARSAL_OWN_CLUSTER=yes
# Libpq variables are not needed by the TS scripts and must not affect child tools.
unset PGDATABASE PGHOST PGPORT PGUSER PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE
node --import tsx scripts/backup/rehearsal.ts
printf 'Owned cluster: %s; free loopback port: %s; shutdown via EXIT trap\n' "$CLUSTER_DIR" "$PORT"
