/**
 * Regression tests for `scripts/drill/ttfe-api-mode.ts` (TRO-621, W6-R55) —
 * the pure mode-selection / container-plan logic behind the TTFE drill's
 * opt-in image mode. Executed by `gate.sh` G11 and CI's "TTFE drill
 * threshold-logic tests" step (same scoped `vitest.config.ts` as
 * `thresholds.test.ts` — see that file's header for why nothing under
 * `scripts/` is covered by api's or web's vitest projects).
 *
 * Each case is the SPECIFIC regression that would make it fail (lessons.md
 * rule 27, "check the negative space"):
 *   - unset / empty / whitespace `DRILL_TTFE_API_IMAGE` must stay tsx — a
 *     version that only checked `!== undefined` would flip a CI `env:` block
 *     with an empty value into image mode with an empty ref;
 *   - the printed mode label is asserted verbatim (a log reader / grader
 *     distinguishes the modes ONLY by this string);
 *   - loopback rewriting must touch `localhost`/`127.0.0.1`/`::1` and NOTHING
 *     else — a version that rewrote every host would break a remote
 *     Postgres; one that only rewrote `localhost` would leave `127.0.0.1`
 *     (what `.factory-env` uses) pointing at the container itself;
 *   - the production-mode container env must carry every var
 *     `api/src/index.ts`/`app.ts`/`ssm.ts` require at boot, and NOT the
 *     `FLEETGRAPH_OAUTH_CLIENT_SECRET` whose presence would make the container
 *     write a first-party OAuth row into an ambient database;
 *   - owned vs ambient Postgres changes exactly two things: the container's
 *     DATABASE_URL (alias vs host.docker.internal) and whether a docker
 *     Network is needed — the host-gateway extra host is present in BOTH
 *     (the webhook target lives on the host either way).
 */
import { describe, expect, it } from 'vitest';
import {
  HOST_DOCKER_INTERNAL,
  IMAGE_API_CONTAINER_PORT,
  OWNED_POSTGRES_ALIAS,
  OWNED_POSTGRES_CERT_PATH,
  OWNED_POSTGRES_KEY_PATH,
  apiBaseUrlForContainer,
  captureListenerBindHost,
  describeApiMode,
  ownedPostgresContainerUrl,
  ownedPostgresTlsCommand,
  planImageApi,
  resolveApiMode,
  rewriteDatabaseUrlForContainer,
  webhookTargetUrlForMode,
} from '../ttfe-api-mode.js';

describe('resolveApiMode', () => {
  it('defaults to tsx when DRILL_TTFE_API_IMAGE is unset', () => {
    expect(resolveApiMode({})).toEqual({ kind: 'tsx' });
    expect(resolveApiMode({ DATABASE_URL: 'postgresql://x' })).toEqual({ kind: 'tsx' });
  });

  it('stays tsx for an empty or whitespace-only DRILL_TTFE_API_IMAGE (a CI env: block with no value)', () => {
    expect(resolveApiMode({ DRILL_TTFE_API_IMAGE: '' })).toEqual({ kind: 'tsx' });
    expect(resolveApiMode({ DRILL_TTFE_API_IMAGE: '   ' })).toEqual({ kind: 'tsx' });
  });

  it('selects image mode with the trimmed ref when DRILL_TTFE_API_IMAGE is set', () => {
    expect(resolveApiMode({ DRILL_TTFE_API_IMAGE: 'ship-api:local' })).toEqual({
      kind: 'image',
      imageRef: 'ship-api:local',
    });
    expect(resolveApiMode({ DRILL_TTFE_API_IMAGE: ' ghcr.io/troysatchell/ship:abc123 ' })).toEqual({
      kind: 'image',
      imageRef: 'ghcr.io/troysatchell/ship:abc123',
    });
  });
});

describe('describeApiMode', () => {
  it('prints the exact per-mode label the drill header/table shows', () => {
    expect(describeApiMode({ kind: 'tsx' })).toBe('api: tsx child');
    expect(describeApiMode({ kind: 'image', imageRef: 'ship-api:local' })).toBe('api: image ship-api:local');
  });
});

describe('rewriteDatabaseUrlForContainer', () => {
  it('rewrites localhost and 127.0.0.1 to host.docker.internal, keeping credentials/port/db/query', () => {
    expect(rewriteDatabaseUrlForContainer('postgresql://ship:pw@localhost:5433/ship_wt?x=1')).toBe(
      `postgresql://ship:pw@${HOST_DOCKER_INTERNAL}:5433/ship_wt?x=1`
    );
    expect(rewriteDatabaseUrlForContainer('postgresql://ship:pw@127.0.0.1:5432/ship_ci')).toBe(
      `postgresql://ship:pw@${HOST_DOCKER_INTERNAL}:5432/ship_ci`
    );
  });

  it('rewrites the IPv6 loopback too', () => {
    expect(rewriteDatabaseUrlForContainer('postgresql://u:p@[::1]:5432/db')).toBe(
      `postgresql://u:p@${HOST_DOCKER_INTERNAL}:5432/db`
    );
  });

  it('leaves a non-loopback host untouched (a remote Postgres is reachable from either side)', () => {
    const remote = 'postgresql://u:p@db.internal.example:5432/prod';
    expect(rewriteDatabaseUrlForContainer(remote)).toBe(remote);
  });

  it('throws on an unparseable URL rather than guessing', () => {
    expect(() => rewriteDatabaseUrlForContainer('not a url')).toThrow();
  });
});

describe('planImageApi', () => {
  const base = { imageRef: 'ship-api:local', secretEncryptionKey: 'k'.repeat(64), sessionSecret: 's'.repeat(64) };

  it('owned Postgres: DATABASE_URL points at the network alias, a Network is required, host-gateway is still added', () => {
    const plan = planImageApi({ ...base, postgres: 'owned' });

    expect(plan.needsNetwork).toBe(true);
    expect(plan.containerDatabaseUrl).toBe(ownedPostgresContainerUrl());
    expect(plan.containerDatabaseUrl).toContain(`@${OWNED_POSTGRES_ALIAS}:5432/`);
    expect(plan.env.DATABASE_URL).toBe(plan.containerDatabaseUrl);
    expect(plan.extraHosts).toEqual([{ host: HOST_DOCKER_INTERNAL, ipAddress: 'host-gateway' }]);
  });

  it('ambient Postgres: DATABASE_URL is the loopback-rewritten host URL and no Network is needed', () => {
    const plan = planImageApi({
      ...base,
      postgres: 'ambient',
      ambientDatabaseUrl: 'postgresql://ship:pw@localhost:5433/ship_wt_tro_621',
    });

    expect(plan.needsNetwork).toBe(false);
    expect(plan.env.DATABASE_URL).toBe(`postgresql://ship:pw@${HOST_DOCKER_INTERNAL}:5433/ship_wt_tro_621`);
    expect(plan.extraHosts).toEqual([{ host: HOST_DOCKER_INTERNAL, ipAddress: 'host-gateway' }]);
  });

  it('ambient Postgres without an ambientDatabaseUrl is a programming error, not a silent owned fallback', () => {
    expect(() => planImageApi({ ...base, postgres: 'ambient' })).toThrow(/ambientDatabaseUrl/);
  });

  it('supplies every env var a NODE_ENV=production boot requires, and nothing that would write into an ambient database', () => {
    const plan = planImageApi({ ...base, postgres: 'owned' });

    expect(plan.env.NODE_ENV).toBe('production');
    expect(plan.env.PORT).toBe(String(IMAGE_API_CONTAINER_PORT));
    expect(plan.containerPort).toBe(IMAGE_API_CONTAINER_PORT);
    // ssm.ts's env fallback needs BOTH; app.ts throws without SESSION_SECRET.
    expect(plan.env.SESSION_SECRET).toBe(base.sessionSecret);
    expect(plan.env.DATABASE_URL).toBeTruthy();
    // POST /api/v1/webhooks 500s without this (encryptSecret throws).
    expect(plan.env.SECRET_ENCRYPTION_KEY).toBe(base.secretEncryptionKey);
    // app.ts does `new URL(path, CORS_ORIGIN)` — must parse.
    expect(() => new URL('/x', plan.env.CORS_ORIGIN)).not.toThrow();
    // Skips the AWS SDK's IMDS probe so the expected SSM fallback is fast.
    expect(plan.env.AWS_EC2_METADATA_DISABLED).toBe('true');
    // Deliberately absent — see ttfe-api-mode.ts's header.
    expect(plan.env).not.toHaveProperty('FLEETGRAPH_OAUTH_CLIENT_SECRET');
  });
});

describe('ownedPostgresTlsCommand', () => {
  it('fixes ownership of the copied-in pair, then execs the image entrypoint with ssl=on (a production api pool refuses plaintext)', () => {
    const cmd = ownedPostgresTlsCommand();
    expect(cmd.slice(0, 2)).toEqual(['sh', '-c']);
    const script = cmd[2] ?? '';
    // Ownership BEFORE the exec — root-owned copied files are unreadable by
    // the postgres user, and Postgres refuses to start on an unreadable key.
    expect(script.indexOf('chown postgres:postgres')).toBeGreaterThanOrEqual(0);
    expect(script.indexOf('chown postgres:postgres')).toBeLessThan(script.indexOf('exec docker-entrypoint.sh postgres'));
    expect(script).toContain(`chmod 600 ${OWNED_POSTGRES_KEY_PATH}`);
    expect(script).toContain('-c ssl=on');
    expect(script).toContain(`ssl_cert_file=${OWNED_POSTGRES_CERT_PATH}`);
    expect(script).toContain(`ssl_key_file=${OWNED_POSTGRES_KEY_PATH}`);
  });
});

describe('per-mode host addressing', () => {
  it('tsx mode keeps the loopback listener + target (unchanged pre-TRO-621 behaviour)', () => {
    expect(captureListenerBindHost({ kind: 'tsx' })).toBe('127.0.0.1');
    expect(webhookTargetUrlForMode({ kind: 'tsx' }, 4567)).toBe('http://127.0.0.1:4567/');
  });

  it('image mode binds all interfaces and targets host.docker.internal (the container\'s 127.0.0.1 is itself)', () => {
    const image = { kind: 'image' as const, imageRef: 'ship-api:local' };
    expect(captureListenerBindHost(image)).toBe('0.0.0.0');
    expect(webhookTargetUrlForMode(image, 4567)).toBe(`http://${HOST_DOCKER_INTERNAL}:4567/`);
  });

  it('apiBaseUrlForContainer dials the docker host on the mapped port', () => {
    expect(apiBaseUrlForContainer('localhost', 55123)).toBe('http://localhost:55123');
  });
});
