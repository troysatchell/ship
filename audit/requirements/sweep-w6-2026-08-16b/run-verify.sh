#!/bin/zsh
# Requirements-audit W6 compare sweep (2026-08-16b) — behavioral verification runner.
# Runs against a THROWAWAY database so `pnpm test`'s TRUNCATE touches nothing shared.
set -u
cd /Users/troy/repos/GAUNTLET/Ship
SWEEP=audit/requirements/sweep-w6-2026-08-16b
SCRATCH_DB=ship_req_audit_w6b_scratch
export DATABASE_URL="postgresql://ship:ship_dev_password@localhost:5433/${SCRATCH_DB}"
# other env from api/.env.local except DATABASE_URL
set -a; eval "$(grep -v '^DATABASE_URL=' api/.env.local)"; set +a
export NODE_ENV=test
echo "== $(date -u) create scratch db ==" > $SWEEP/verify-run.log
docker exec ship-postgres-1 psql -U ship -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH_DB}" >> $SWEEP/verify-run.log 2>&1
docker exec ship-postgres-1 psql -U ship -d postgres -c "CREATE DATABASE ${SCRATCH_DB}" >> $SWEEP/verify-run.log 2>&1
echo "== $(date -u) migrate ==" >> $SWEEP/verify-run.log
pnpm db:migrate > $SWEEP/migrate.log 2>&1; echo "migrate exit=$?" >> $SWEEP/verify-run.log
docker exec ship-postgres-1 psql -U ship -d ${SCRATCH_DB} -c "select count(*) as applied from schema_migrations" >> $SWEEP/verify-run.log 2>&1
docker exec ship-postgres-1 psql -U ship -d ${SCRATCH_DB} -c "\d oauth_apps" > $SWEEP/d-oauth_apps.txt 2>&1
docker exec ship-postgres-1 psql -U ship -d ${SCRATCH_DB} -c "\d oauth_tokens" > $SWEEP/d-oauth_tokens.txt 2>&1
docker exec ship-postgres-1 psql -U ship -d ${SCRATCH_DB} -c "\d webhook_subscriptions" > $SWEEP/d-webhook_subscriptions.txt 2>&1
docker exec ship-postgres-1 psql -U ship -d ${SCRATCH_DB} -c "\d webhook_deliveries" > $SWEEP/d-webhook_deliveries.txt 2>&1
docker exec ship-postgres-1 psql -U ship -d ${SCRATCH_DB} -c "\d public_api_audit" > $SWEEP/d-public_api_audit.txt 2>&1
docker exec ship-postgres-1 psql -U ship -d ${SCRATCH_DB} -c "\d api_tokens" > $SWEEP/d-api_tokens.txt 2>&1
docker exec ship-postgres-1 psql -U ship -d ${SCRATCH_DB} -c "\d oauth_device_codes" > $SWEEP/d-oauth_device_codes.txt 2>&1
docker exec ship-postgres-1 psql -U ship -d ${SCRATCH_DB} -c "select id from schema_migrations order by id" > $SWEEP/schema_migrations.txt 2>&1
echo "== $(date -u) type-check ==" >> $SWEEP/verify-run.log
pnpm type-check > $SWEEP/typecheck.log 2>&1; echo "typecheck exit=$?" >> $SWEEP/verify-run.log
echo "== $(date -u) pnpm test ==" >> $SWEEP/verify-run.log
pnpm test > $SWEEP/test.log 2>&1; echo "test exit=$?" >> $SWEEP/verify-run.log
echo "== $(date -u) drop scratch db ==" >> $SWEEP/verify-run.log
docker exec ship-postgres-1 psql -U ship -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH_DB}" >> $SWEEP/verify-run.log 2>&1
echo "== $(date -u) DONE ==" >> $SWEEP/verify-run.log
