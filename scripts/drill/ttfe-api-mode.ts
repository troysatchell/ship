/**
 * TTFE drill — API mode selection + container-plan helpers (TRO-621, W6-R55).
 *
 * Ruling I-07 reads "containerized Ship instance" as: the API under test runs
 * from the SAME container image the repo's root `Dockerfile` builds and CI's
 * `build-image` job pushes — not `tsx src/index.ts` from the checkout, which
 * is what `scripts/drill/ttfe.ts` did exclusively before this ticket (only
 * Postgres was ever containerized).
 *
 * Everything in this file is PURE — env in, plain data out — so the
 * mode-selection and container-env decisions are unit-testable
 * (`__tests__/ttfe-api-mode.test.ts`, executed by `gate.sh` G11 and CI's
 * "TTFE drill threshold-logic tests" step) without Docker, a database, or a
 * running API. `ttfe.ts` consumes these plans and does the actual
 * spawning/starting.
 *
 * Two modes, selected by ONE opt-in env var:
 *
 *   - `DRILL_TTFE_API_IMAGE` unset      → `tsx` mode (the default; behaviour
 *                                          byte-identical to before this
 *                                          ticket — same spawn args, same env,
 *                                          same readiness detection).
 *   - `DRILL_TTFE_API_IMAGE=<image ref>` → `image` mode: start `<image ref>`
 *                                          with testcontainers' GenericContainer,
 *                                          NODE_ENV=production, wait for
 *                                          `GET /health` 200, run the same six
 *                                          stages against the mapped port.
 *
 * ── Why the container runs `NODE_ENV=production` (and what that drags in) ──
 * The Dockerfile bakes `ENV NODE_ENV=production`; overriding it to
 * `development` for the drill would repeat this repo's own documented
 * incident (CLAUDE.md "Claim provenance": a container smoke test that passed
 * BECAUSE `NODE_ENV=development` returned early past the broken code in
 * `ssm.ts:39`). So the drill keeps production and supplies exactly what
 * production boot needs (read from `api/src/index.ts`, `api/src/app.ts`,
 * `api/src/config/ssm.ts`, `api/src/db/ssl.ts`):
 *
 *   - `DATABASE_URL` + `SESSION_SECRET` — required together for
 *     `loadProductionSecrets()`'s "SSM unavailable, continue with env" fallback
 *     (`ssm.ts`), and `app.ts` throws at import without SESSION_SECRET.
 *   - `SECRET_ENCRYPTION_KEY` — `POST /api/v1/webhooks` 500s without it (same
 *     reason tsx mode already passes it).
 *   - `CORS_ORIGIN` — must be a well-formed URL base (`app.ts`'s
 *     `new URL(path, webOrigin)`); never dialed by this drill.
 *   - `AWS_EC2_METADATA_DISABLED=true` — the AWS SDK's default credential chain
 *     otherwise probes IMDS (169.254.169.254) on every SSM attempt; in a
 *     container with no route there that is a slow timeout, not a fast
 *     failure. Skipping it makes the (expected, logged) SSM fallback quick.
 *   - `PORT` — the port the API listens on INSIDE the container.
 *
 *   NOT supplied on purpose: `FLEETGRAPH_OAUTH_CLIENT_SECRET`. `index.ts`'s
 *   boot check logs a loud `console.error` and continues without it; setting
 *   it would make the container INSERT the first-party `ship_app_fleetgraph`
 *   row into whatever database it points at (an ambient factory database,
 *   for instance) — a side effect this drill's own `cleanupPrincipal` does not
 *   own. The error line in DEBUG output is expected in this mode.
 *
 * ── Database TLS: the production-mode consequence that decides where Postgres
 *    comes from ──
 * `api/src/db/ssl.ts` — the ONE SSL decision for every pool — returns
 * `{ rejectUnauthorized: false }` whenever `NODE_ENV === 'production'`, so
 * both `migrate.js` (the image CMD's first command) and the app pool REQUIRE a
 * TLS-capable Postgres. Neither CI's `services:` `postgres:15-alpine` nor a
 * default local/factory Postgres (`ssl = off`) accepts TLS. So in image mode:
 *
 *   - `DATABASE_URL` set AND that server accepts TLS  → 'ambient' Postgres:
 *     the container reaches it via `host.docker.internal` (Docker's
 *     `host-gateway` extra host); loopback hostnames in the URL are rewritten
 *     for the container's point of view (`rewriteDatabaseUrlForContainer`).
 *   - `DATABASE_URL` set but the server is plaintext-only → 'owned' Postgres:
 *     the drill starts its OWN `postgres:15` with `ssl=on` against a
 *     self-signed cert it generates on the host (see
 *     `ownedPostgresTlsCommand`), on a private docker Network the API
 *     container joins, reached by network alias. Logged loudly with the reason (never silent — the
 *     ambient database is being bypassed, and the operator should know why).
 *   - `DATABASE_URL` unset → 'owned' Postgres, same as above.
 *
 * `ttfe.ts` decides between the first two by PROBING the ambient server once
 * (`probeAmbientPostgres` there); this file only encodes what each decision
 * means for the container.
 */

export type TtfeApiMode = { kind: 'tsx' } | { kind: 'image'; imageRef: string };

/** Which Postgres the API container talks to — see the file header. */
export type ImagePostgresSource = 'owned' | 'ambient';

/** Docker's magic hostname for "the host running the daemon", made
 *  resolvable on Linux via the `host-gateway` extra host below (Docker
 *  Desktop resolves it natively). */
export const HOST_DOCKER_INTERNAL = 'host.docker.internal';
export const HOST_GATEWAY_EXTRA_HOST = { host: HOST_DOCKER_INTERNAL, ipAddress: 'host-gateway' } as const;

/** Network alias the drill-owned Postgres container is reachable by from
 *  the API container (both joined to one testcontainers Network). */
export const OWNED_POSTGRES_ALIAS = 'ttfe-postgres';
export const OWNED_POSTGRES_IMAGE = 'postgres:15';
export const OWNED_POSTGRES_DB = 'ttfe_drill';
export const OWNED_POSTGRES_USER = 'ttfe';
export const OWNED_POSTGRES_PASSWORD = 'ttfe';

/** Where the drill's freshly generated, one-day, self-signed server cert +
 *  key are copied INTO the owned Postgres container. Not the Debian
 *  `ssl-cert` snakeoil pair: that only exists in the Debian variant of the
 *  image (not `-alpine`), and even a `postgres:15` tag is not guaranteed to
 *  BE the Debian variant on a given machine (observed locally: `postgres:15`
 *  and `postgres:15-alpine` sharing one image ID). Generating our own cert
 *  on the host (`openssl req -x509`, present on macOS and on GitHub's ubuntu
 *  runners) removes that dependency on image internals. */
export const OWNED_POSTGRES_CERT_PATH = '/var/lib/postgresql/ttfe-server.crt';
export const OWNED_POSTGRES_KEY_PATH = '/var/lib/postgresql/ttfe-server.key';

/** The container command for the owned, TLS-enabled Postgres. Files copied
 *  in by testcontainers arrive root-owned; Postgres refuses a key file the
 *  server user cannot read, so the wrapper (running as root — the image's
 *  entrypoint only drops privileges when its first arg is `postgres`)
 *  chowns/chmods the pair to the `postgres` user first, then `exec`s the
 *  image's own entrypoint with `ssl=on`. Works for both the Debian and the
 *  Alpine variants (both have `sh`, `chown`, `chmod`, and the same
 *  `docker-entrypoint.sh`). */
export function ownedPostgresTlsCommand(): string[] {
  const script = [
    `chown postgres:postgres ${OWNED_POSTGRES_CERT_PATH} ${OWNED_POSTGRES_KEY_PATH}`,
    `chmod 600 ${OWNED_POSTGRES_KEY_PATH}`,
    `chmod 644 ${OWNED_POSTGRES_CERT_PATH}`,
    `exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=${OWNED_POSTGRES_CERT_PATH} -c ssl_key_file=${OWNED_POSTGRES_KEY_PATH}`,
  ].join(' && ');
  return ['sh', '-c', script];
}

/** Port the API listens on inside the container (`Dockerfile` EXPOSEs 3000
 *  and `index.ts` defaults to it; passed explicitly as PORT anyway). */
export const IMAGE_API_CONTAINER_PORT = 3000;

/** Sole selector: `DRILL_TTFE_API_IMAGE`. Whitespace-only counts as unset so
 *  a `DRILL_TTFE_API_IMAGE=` in a CI `env:` block cannot silently select
 *  image mode with an empty ref (which would fail confusingly deep inside
 *  testcontainers instead of here). */
export function resolveApiMode(env: NodeJS.ProcessEnv): TtfeApiMode {
  const raw = env.DRILL_TTFE_API_IMAGE?.trim();
  if (raw) return { kind: 'image', imageRef: raw };
  return { kind: 'tsx' };
}

/** The exact header/table label the drill prints for each mode. */
export function describeApiMode(mode: TtfeApiMode): string {
  return mode.kind === 'image' ? `api: image ${mode.imageRef}` : 'api: tsx child';
}

/** The connection URI the API container uses for a drill-OWNED Postgres:
 *  the network alias + the container-internal port, never the host-mapped
 *  one (the container is on the same docker network, not on the host). */
export function ownedPostgresContainerUrl(): string {
  return `postgresql://${OWNED_POSTGRES_USER}:${OWNED_POSTGRES_PASSWORD}@${OWNED_POSTGRES_ALIAS}:5432/${OWNED_POSTGRES_DB}`;
}

/** Rewrites a host-side `DATABASE_URL` so it is reachable FROM the API
 *  container: any loopback hostname (`localhost`, `127.0.0.1`, `[::1]`)
 *  becomes `host.docker.internal`. Every other hostname is left untouched —
 *  a genuinely remote Postgres is equally reachable from either side. Throws
 *  on an unparseable URL rather than guessing. */
export function rewriteDatabaseUrlForContainer(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    url.hostname = HOST_DOCKER_INTERNAL;
  }
  return url.toString();
}

/** Where the API container's webhook deliverer must POST to reach the
 *  drill's capture listener on the host — the container's `127.0.0.1` is
 *  the container itself, so the listener must be addressed as
 *  `host.docker.internal` (and `ttfe.ts` binds it to `0.0.0.0` in image
 *  mode for exactly this reason). */
export function webhookTargetUrlForMode(mode: TtfeApiMode, listenerPort: number): string {
  const host = mode.kind === 'image' ? HOST_DOCKER_INTERNAL : '127.0.0.1';
  return `http://${host}:${listenerPort}/`;
}

/** Bind address for the capture listener per mode — loopback in tsx mode
 *  (unchanged), all interfaces in image mode so the docker bridge /
 *  host-gateway path can reach it. */
export function captureListenerBindHost(mode: TtfeApiMode): string {
  return mode.kind === 'image' ? '0.0.0.0' : '127.0.0.1';
}

export interface ImageApiPlanInput {
  imageRef: string;
  postgres: ImagePostgresSource;
  /** Host-side DATABASE_URL — required (and only read) when `postgres === 'ambient'`. */
  ambientDatabaseUrl?: string;
  secretEncryptionKey: string;
  sessionSecret: string;
}

export interface ImageApiPlan {
  imageRef: string;
  postgres: ImagePostgresSource;
  containerPort: number;
  /** DATABASE_URL as the CONTAINER must see it. */
  containerDatabaseUrl: string;
  env: Record<string, string>;
  /** Always includes host-gateway: the webhook target (and, when ambient,
   *  Postgres) live on the host. */
  extraHosts: Array<{ host: string; ipAddress: string }>;
  /** True when `ttfe.ts` must create a docker Network and join both
   *  containers to it (owned Postgres reached by alias). */
  needsNetwork: boolean;
}

/** Everything `ttfe.ts` needs to start the API container, as plain data. */
export function planImageApi(input: ImageApiPlanInput): ImageApiPlan {
  let containerDatabaseUrl: string;
  if (input.postgres === 'ambient') {
    if (!input.ambientDatabaseUrl) {
      throw new Error('planImageApi: postgres="ambient" requires ambientDatabaseUrl');
    }
    containerDatabaseUrl = rewriteDatabaseUrlForContainer(input.ambientDatabaseUrl);
  } else {
    containerDatabaseUrl = ownedPostgresContainerUrl();
  }

  return {
    imageRef: input.imageRef,
    postgres: input.postgres,
    containerPort: IMAGE_API_CONTAINER_PORT,
    containerDatabaseUrl,
    env: {
      NODE_ENV: 'production',
      PORT: String(IMAGE_API_CONTAINER_PORT),
      DATABASE_URL: containerDatabaseUrl,
      SESSION_SECRET: input.sessionSecret,
      SECRET_ENCRYPTION_KEY: input.secretEncryptionKey,
      // Same never-dialed, well-formed URL base tsx mode passes.
      CORS_ORIGIN: 'http://127.0.0.1:1',
      // See file header: skip the AWS SDK's IMDS probe so the expected
      // "SSM unavailable — continuing with secrets supplied by the
      // environment" fallback in ssm.ts is fast, not a slow timeout.
      AWS_EC2_METADATA_DISABLED: 'true',
    },
    extraHosts: [HOST_GATEWAY_EXTRA_HOST],
    needsNetwork: input.postgres === 'owned',
  };
}

/** The base URL the drill's stages dial: the docker host + the port Docker
 *  mapped the container's API port to. */
export function apiBaseUrlForContainer(dockerHost: string, mappedPort: number): string {
  return `http://${dockerHost}:${mappedPort}`;
}
