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
 * WIRED (TRO-367 / W5-R36) into an automatic trigger: `.github/workflows/
 * agent-rollback-check.yml` runs this script with `--execute` on a schedule
 * (every 15 minutes) plus `workflow_dispatch`. That workflow is the "WHEN it
 * runs" decision this docstring used to say was still open. What it does NOT
 * do, and could not do inside this factory's escalation policy
 * (`.claude/skills/ship-factory/references/escalation.md`), is provision the
 * two secrets (`RENDER_API_KEY`, `RENDER_AGENT_SERVICE_ID`) the workflow
 * needs to actually reach Render — that is exactly the outward-facing,
 * credential-bearing step every prior live Render/Terraform action in
 * FLEETGRAPH.MD required explicit human sign-off for, and the workflow
 * itself refuses to guess: `parseArgs` rejects `--execute` without
 * `--service-id` (below), and `main()` refuses to proceed without
 * `RENDER_API_KEY`. Until a human sets both secrets, the workflow runs on
 * schedule, finds nothing configured, and reports a warning annotation
 * rather than either failing loudly or silently doing nothing — see that
 * workflow file's own comments. The full poll -> evaluate -> decide -> call
 * Render pipeline is exported as `runReadinessCheck` below specifically so a
 * test can exercise it end to end against fakes — see
 * `check-readiness-and-rollback.test.ts`'s `runReadinessCheck` suite, the
 * dry-run/simulated-failure demonstration in place of a live exercise. This
 * script's own decision logic is separately proven in `deployReadiness.test.ts`,
 * and the underlying "boots but broken" gap it closes was proven once by
 * local simulation against real running agent server processes (see
 * CHANGES.md's TRO-322 entry for that transcript) — neither of those was
 * against the actually-deployed production service, and no live rollback has
 * ever been exercised against it.
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
import {
  evaluateReadinessSamples,
  pollReadiness,
  type ReadinessEvaluation,
  type ReadinessFetcher,
  type ReadinessSample,
} from '../deployReadiness.js';

export interface ParsedArgs {
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

export interface RenderDeploy {
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

async function rollbackViaRenderApi(
  serviceId: string,
  apiKey: string,
  fetchImpl: typeof fetch
): Promise<RenderDeploy> {
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
  return target;
}

/**
 * Dependencies for `runReadinessCheck` — everything the pipeline needs to
 * poll, decide, and (conditionally) act, all injectable so a test can run
 * the FULL trigger — poll -> evaluate -> decide -> call Render — against
 * fakes only, never a real network call. This is the TRO-367 wiring: before
 * this function existed, `pollReadiness`/`evaluateReadinessSamples` (the
 * decision) and `rollbackViaRenderApi` (the action) were each unit-tested in
 * isolation, but nothing proved they were actually wired together end to
 * end. See `check-readiness-and-rollback.test.ts`'s `runReadinessCheck`
 * suite for that proof.
 */
export interface RunCheckDeps {
  fetcher: ReadinessFetcher;
  /** Used only for the Render API calls inside `rollbackViaRenderApi` — never for polling `/ready` (that's `fetcher`). */
  fetchImpl: typeof fetch;
  /** Render API key. `main()` reads this from `process.env.RENDER_API_KEY`; tests inject it directly so nothing here ever touches `process.env`. */
  apiKey: string | undefined;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Called once, right after polling and evaluating, before any rollback
   * action is attempted. Lets `main()` print the sample/evaluation lines in
   * the same place it always has without `runReadinessCheck` owning any
   * console output itself. Tests omit it. */
  onEvaluated?: (samples: readonly ReadinessSample[], evaluation: ReadinessEvaluation) => void;
}

export type RunCheckOutcome = 'healthy' | 'transient' | 'dry_run_warn' | 'missing_api_key' | 'rolled_back';

export interface RunCheckResult {
  outcome: RunCheckOutcome;
  evaluation: ReadinessEvaluation;
  samples: ReadinessSample[];
  /** Set only when `outcome === 'rolled_back'` — the deploy that was re-triggered. */
  rolledBackTo?: RenderDeploy;
}

/**
 * The automatic trigger's full decision-to-action pipeline: poll `/ready`,
 * decide whether the failure is sustained (`evaluateReadinessSamples`), and
 * — only when the caller asked for `--execute` and a Render API key is
 * available — actually call Render to redeploy the previous known-good
 * commit (`rollbackViaRenderApi`). `main()` is a thin wrapper that supplies
 * the real `fetch`/`process.env.RENDER_API_KEY` and translates the result
 * into console output + exit codes; a test supplies fakes for both and
 * asserts on the returned `RunCheckResult` instead.
 */
export async function runReadinessCheck(args: ParsedArgs, deps: RunCheckDeps): Promise<RunCheckResult> {
  const samples = await pollReadiness({
    url: args.url,
    attempts: args.attempts,
    intervalMs: args.intervalMs,
    fetcher: deps.fetcher,
    now: deps.now,
    sleep: deps.sleep,
  });
  const evaluation = evaluateReadinessSamples(samples);
  deps.onEvaluated?.(samples, evaluation);

  if (!evaluation.rollbackWarranted) {
    return { outcome: evaluation.failureCount === 0 ? 'healthy' : 'transient', evaluation, samples };
  }

  if (!args.execute) {
    return { outcome: 'dry_run_warn', evaluation, samples };
  }

  if (!deps.apiKey) {
    return { outcome: 'missing_api_key', evaluation, samples };
  }

  // args.serviceId is guaranteed by parseArgs when args.execute is true.
  const rolledBackTo = await rollbackViaRenderApi(args.serviceId as string, deps.apiKey, deps.fetchImpl);
  return { outcome: 'rolled_back', evaluation, samples, rolledBackTo };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Polling ${args.url} — ${args.attempts} attempt(s), ${args.intervalMs}ms apart...`);
  const result = await runReadinessCheck(args, {
    fetcher: { get: (url) => fetch(url) },
    fetchImpl: fetch,
    apiKey: process.env.RENDER_API_KEY,
    onEvaluated: (samples, evaluation) => {
      for (const s of samples) {
        console.log(`  ${s.at}  ready=${s.ready}  reason=${s.reason}`);
      }
      console.log(`Evaluation: ${JSON.stringify(evaluation)}`);
    },
  });

  switch (result.outcome) {
    case 'healthy':
    case 'transient':
      console.log('No sustained readiness failure detected. No action taken.');
      return;
    case 'dry_run_warn':
      console.error(`SUSTAINED READINESS FAILURE: ${result.evaluation.reason}`);
      console.error(
        'Dry run (pass --execute --service-id <id> with RENDER_API_KEY set to actually roll back). ' +
          'Exiting 2 to signal "rollback warranted" to a caller that wants to alert on this.'
      );
      process.exitCode = 2;
      return;
    case 'missing_api_key':
      console.error(`SUSTAINED READINESS FAILURE: ${result.evaluation.reason}`);
      console.error('--execute was passed but RENDER_API_KEY is not set. Refusing to guess a credential.');
      process.exitCode = 1;
      return;
    case 'rolled_back':
      console.error(`SUSTAINED READINESS FAILURE: ${result.evaluation.reason}`);
      // rollbackViaRenderApi already logged the "Rolling back..." / "...triggered successfully." lines.
      return;
  }
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
