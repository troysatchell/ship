#!/bin/zsh
# Second pass: root `pnpm test` short-circuits after the api suite's single failure (&& chain),
# so run the remaining package suites individually + re-run the one failed api file in isolation.
set -u
cd /Users/troy/repos/GAUNTLET/Ship
SWEEP=audit/requirements/sweep-w6-2026-08-16b
SCRATCH_DB=ship_req_audit_w6b_scratch
export DATABASE_URL="postgresql://ship:ship_dev_password@localhost:5433/${SCRATCH_DB}"
set -a; eval "$(grep -v '^DATABASE_URL=' api/.env.local)"; set +a
export NODE_ENV=test
L=$SWEEP/verify-run-2.log
echo "== $(date -u) create scratch db ==" > $L
docker exec ship-postgres-1 psql -U ship -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH_DB}" >> $L 2>&1
docker exec ship-postgres-1 psql -U ship -d postgres -c "CREATE DATABASE ${SCRATCH_DB}" >> $L 2>&1
pnpm db:migrate > $SWEEP/migrate-2.log 2>&1; echo "migrate exit=$?" >> $L
echo "== $(date -u) api activity.test.ts isolated rerun x2 ==" >> $L
(cd api && npx vitest run src/__tests__/activity.test.ts) > $SWEEP/test-api-activity-rerun1.log 2>&1; echo "activity rerun1 exit=$?" >> $L
(cd api && npx vitest run src/__tests__/activity.test.ts) > $SWEEP/test-api-activity-rerun2.log 2>&1; echo "activity rerun2 exit=$?" >> $L
echo "== $(date -u) test:web ==" >> $L
pnpm test:web > $SWEEP/test-web.log 2>&1; echo "web exit=$?" >> $L
echo "== $(date -u) test:agent ==" >> $L
pnpm test:agent > $SWEEP/test-agent.log 2>&1; echo "agent exit=$?" >> $L
echo "== $(date -u) test:sdk ==" >> $L
pnpm test:sdk > $SWEEP/test-sdk.log 2>&1; echo "sdk exit=$?" >> $L
echo "== $(date -u) test:cli ==" >> $L
pnpm test:cli > $SWEEP/test-cli.log 2>&1; echo "cli exit=$?" >> $L
echo "== $(date -u) drop scratch db ==" >> $L
docker exec ship-postgres-1 psql -U ship -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH_DB}" >> $L 2>&1
echo "== $(date -u) DONE ==" >> $L
