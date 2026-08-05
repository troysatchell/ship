/**
 * Corrective-rollback CLI (TRO-322 / FG-12) — the tool that closes the gap
 * FLEETGRAPH.MD's "Rollback trigger and procedure" section names as
 * uncovered: a deploy that boots (passes `/health`) but is missing config or
 * cannot reach Ship still gets promoted to live traffic by Render today,
 * because Render's platform check watches `/health` (liveness), never
 * `/ready` (readiness). See `deployReadiness.ts`'s own module docstring for
 * the full reasoning and the sustained-vs-transient distinction this script
 * is built around.
 *
 * NOT wired into any live trigger against production in this change. This is
 * deliberate: running it automatically against a real Render service needs
 * `RENDER_API_KEY` and a decision about WHEN it runs (a scheduled job, a
 * post-deploy webhook) — both are the kind of outward-facing, irreversible-
 * if-wrong infrastructure change this factory's escalation policy reserves
 * for explicit human sign-off (`.claude/skills/ship-factory/references/
 * escalation.md`; see also FLEETGRAPH.MD's own precedent of "explicit human
 * sign-off" on every prior live Render/Terraform action). This script is the
 * real, tested, runnable mechanism — proven in `deployReadiness.test.ts`
 * (the decision logic) and by local simulation against real running agent
 * server processes (see CHANGES.md's TRO-322 entry for the transcript) — the
 * remaining step (actually scheduling it with real credentials against the
 * live service) is a recommendation for a human to apply, not something this
 * script does on its own.
 *
 * Usage:
 *   tsx src/scripts/check-readiness-and-rollback.ts \
 *     --url https://ship-agent-t0zy.onrender.com/ready \
 *     --attempts 3 --interval-ms 30000 \
 *     [--service-id srv-xxxx --execute]
 *
 * Without --execute (the default), a sustained failure is reported and the
 * process exits 2 ("rollback warranted") without calling Render at all —
 * safe to run against a real URL with no credentials. --execute additionally
 * requires --service-id and a RENDER_API_KEY in the environment, and will
 * make real Render API calls: it looks up the most recent LIVE deploy that
 * is not the current one and re-triggers it via `POST /v1/services/{id}/
 * deploys` with that deploy's `commitId` — Render's documented mechanism for
 * redeploying a specific prior commit on a docker/branch-tracking service.
 */
import { evaluateReadinessSamples, pollReadiness, type ReadinessFetcher } from '../deployReadiness.js';

interface ParsedArgs {
  url: string;
  attempts: number;
  intervalMs: number;
  serviceId: string | undefined;
  execute: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let url: string | undefined;
  let attempts = 3;
  let intervalMs = 30_000;
  let serviceId: string | undefined;
  let execute = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--url':
        url = argv[++i];
        break;
      case '--attempts':
        attempts = Number.parseInt(argv[++i] ?? '', 10);
        break;
      case '--interval-ms':
        intervalMs = Number.parseInt(argv[++i] ?? '', 10);
        break;
      case '--service-id':
        serviceId = argv[++i];
        break;
      case '--execute':
        execute = true;
        break;
      default:
        throw new Error(`Unrecognized argument: ${arg}`);
    }
  }

  if (!url) throw new Error('--url is required (the /ready endpoint to poll).');
  if (!Number.isFinite(attempts) || attempts < 2) {
    throw new Error(
      '--attempts must be >= 2 — a single sample can never distinguish a sustained failure ' +
        'from the transient Ship-down blip FLEETGRAPH.MD explicitly says must not trigger a rollback.'
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('--interval-ms must be a non-negative number.');
  }
  if (execute && !serviceId) {
    throw new Error('--execute requires --service-id.');
  }

  return { url, attempts, intervalMs, serviceId, execute };
}

interface RenderDeploy {
  id: string;
  commit?: { id?: string };
  status: string;
  createdAt: string;
}

/** Finds the most recent deploy whose status is `live` and whose id is not
 * `excludeDeployId` — the "previous known-good" target to redeploy. Returns
 * `undefined` when none exists (nothing to roll back to). */
export function findPreviousLiveDeploy(
  deploys: readonly RenderDeploy[],
  excludeDeployId: string | undefined
): RenderDeploy | undefined {
  return deploys
    .filter((d) => d.status === 'live' && d.id !== excludeDeployId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

async function rollbackViaRenderApi(serviceId: string, apiKey: string, fetchImpl: typeof fetch): Promise<void> {
  const deploysRes = await fetchImpl(
    `https://api.render.com/v1/services/${serviceId}/deploys?limit=20`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!deploysRes.ok) {
    throw new Error(`GET .../deploys failed: ${deploysRes.status} ${await deploysRes.text()}`);
  }
  const body: unknown = await deploysRes.json();
  // Render's list endpoint wraps each entry as `{ deploy: {...} }`.
  const entries = Array.isArray(body) ? body : [];
  const deploys: RenderDeploy[] = entries
    .map((e) => (e && typeof e === 'object' && 'deploy' in e ? (e as { deploy: unknown }).deploy : e))
    .filter((d): d is RenderDeploy => Boolean(d && typeof d === 'object'));

  const current = deploys.filter((d) => d.status === 'live').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const target = findPreviousLiveDeploy(deploys, current?.id);
  if (!target?.commit?.id) {
    throw new Error(
      'No previous live deploy with a resolvable commit id was found — nothing to roll back to. ' +
        'This service may only have ever had one successful deploy.'
    );
  }

  console.log(`Rolling back ${serviceId} to previous live deploy ${target.id} (commit ${target.commit.id})...`);
  const rollbackRes = await fetchImpl(`https://api.render.com/v1/services/${serviceId}/deploys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commitId: target.commit.id }),
  });
  if (!rollbackRes.ok) {
    throw new Error(`POST .../deploys (rollback) failed: ${rollbackRes.status} ${await rollbackRes.text()}`);
  }
  console.log('Rollback deploy triggered successfully.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const fetcher: ReadinessFetcher = { get: (url) => fetch(url) };
  console.log(`Polling ${args.url} — ${args.attempts} attempt(s), ${args.intervalMs}ms apart...`);
  const samples = await pollReadiness({
    url: args.url,
    attempts: args.attempts,
    intervalMs: args.intervalMs,
    fetcher,
  });
  for (const s of samples) {
    console.log(`  ${s.at}  ready=${s.ready}  reason=${s.reason}`);
  }

  const evaluation = evaluateReadinessSamples(samples);
  console.log(`Evaluation: ${JSON.stringify(evaluation)}`);

  if (!evaluation.rollbackWarranted) {
    console.log('No sustained readiness failure detected. No action taken.');
    return;
  }

  console.error(`SUSTAINED READINESS FAILURE: ${evaluation.reason}`);

  if (!args.execute) {
    console.error(
      'Dry run (pass --execute --service-id <id> with RENDER_API_KEY set to actually roll back). ' +
        'Exiting 2 to signal "rollback warranted" to a caller that wants to alert on this.'
    );
    process.exitCode = 2;
    return;
  }

  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) {
    console.error('--execute was passed but RENDER_API_KEY is not set. Refusing to guess a credential.');
    process.exitCode = 1;
    return;
  }
  // args.serviceId is guaranteed by parseArgs when args.execute is true.
  await rollbackViaRenderApi(args.serviceId as string, apiKey, fetch);
}

// Only run when executed directly (`tsx src/scripts/check-readiness-and-rollback.ts`),
// never on import — `check-readiness-and-rollback.test.ts` imports `parseArgs`/
// `findPreviousLiveDeploy` directly to unit-test them without triggering a real
// network call. Same guard `cost-report.ts` already uses for the identical
// reason. Compares resolved file URLs rather than `require.main` (this
// package is ESM, `"type": "module"`).
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('check-readiness-and-rollback failed:', err);
    process.exitCode = 1;
  });
}
