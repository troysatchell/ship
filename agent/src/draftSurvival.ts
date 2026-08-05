/**
 * The draft-survival metric (TRO-338 / FG-20) — "the production signal that
 * matters more than the offline set: how much of a draft survives to the
 * posted version, unedited. A draft posted unedited was good; one
 * rewritten from scratch was not." Zero labelling effort, per the ticket:
 * it is a comparison between two strings this codebase already has on hand
 * at the moment a draft is accepted — the model's original composition
 * (`StandupDraft.draftText`, immutable since TRO-319) and what the
 * accepting person actually posted (`gate.ts`'s `acceptDraft` already
 * receives this as `finalText`, and now also asks `draftStore.markPosted`
 * to retain it — see that file's own comment on why it did not before this
 * ticket).
 *
 * Mirrors `costTracking.ts`'s exact shape (`Tracker` interface,
 * `FileXTracker` production implementation, JSONL-append, `aggregate`) —
 * proven, already-reviewed pattern in this exact package for "record a
 * real per-event production observation to a local file, non-blocking,
 * never able to fail the real operation it accounts for."
 */
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTextSimilarity } from './textSimilarity.js';

/** One accepted draft's survival measurement. `similarity` is
 * `computeTextSimilarity(finalText, draftText)` — the same scorer
 * `goldenSet.ts` uses for a different comparison (see that file's own
 * docstring for why one scorer answers both questions). `identical` is a
 * stronger, unambiguous companion signal: "posted completely unedited,"
 * which `similarity` alone cannot promise since two DIFFERENT texts can
 * still score close to 1. */
export interface DraftSurvivalRecord {
  /** ISO 8601. */
  timestamp: string;
  draftId: string;
  personUserId: string;
  draftTextLength: number;
  finalTextLength: number;
  /** `computeTextSimilarity(finalText, draftText)`, in `[0, 1]`. */
  similarity: number;
  /** `finalText === draftText`, exactly — the strongest possible survival
   * signal, and one `similarity` cannot substitute for (see this
   * interface's own docstring). */
  identical: boolean;
}

/** Pure computation, no I/O — the seam `gate.ts` calls directly, and what
 * `draftSurvival.test.ts` exercises without needing a tracker or a real
 * filesystem. */
export function computeDraftSurvival(
  draftId: string,
  personUserId: string,
  draftText: string,
  finalText: string,
  now: () => Date = () => new Date()
): DraftSurvivalRecord {
  return {
    timestamp: now().toISOString(),
    draftId,
    personUserId,
    draftTextLength: draftText.length,
    finalTextLength: finalText.length,
    similarity: computeTextSimilarity(finalText, draftText),
    identical: finalText === draftText,
  };
}

/** The injection seam `gate.ts`'s `GateDeps` takes — same optional,
 * production-implementation-elsewhere pattern as `CostTracker` in
 * `graph.ts`/`costTracking.ts`. */
export interface DraftSurvivalTracker {
  record(entry: DraftSurvivalRecord): Promise<void>;
}

/** `<agent package root>/.cache/draft-survival-ledger.jsonl` — same
 * gitignored, survives-build location as `costTracking.ts`'s cost ledger,
 * for the identical reason (already covered by the repo's root `.cache`
 * `.gitignore` pattern at any depth). */
const DEFAULT_LEDGER_PATH = fileURLToPath(new URL('../.cache/draft-survival-ledger.jsonl', import.meta.url));

export interface FileDraftSurvivalTrackerOptions {
  /** Override the ledger path — tests use a scratch path so runs never
   * share or pollute the real development ledger (lessons.md #20, matching
   * `FileCostTracker`'s identical option). */
  ledgerPath?: string;
}

export class FileDraftSurvivalTracker implements DraftSurvivalTracker {
  readonly ledgerPath: string;

  constructor(options: FileDraftSurvivalTrackerOptions = {}) {
    this.ledgerPath = options.ledgerPath || process.env.AGENT_DRAFT_SURVIVAL_LEDGER_PATH || DEFAULT_LEDGER_PATH;
  }

  async record(entry: DraftSurvivalRecord): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    await appendFile(this.ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Every record currently on disk, in file order. `[]` if the ledger
   * doesn't exist yet (no draft has ever been accepted). Same
   * skip-malformed-lines posture as `FileCostTracker.readAll` — a
   * hand-edited or partially-written last line should not take down the
   * whole report. */
  readAll(): DraftSurvivalRecord[] {
    if (!existsSync(this.ledgerPath)) return [];
    const raw = readFileSync(this.ledgerPath, 'utf8');
    const records: DraftSurvivalRecord[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isDraftSurvivalRecord(parsed)) records.push(parsed);
    }
    return records;
  }
}

function isDraftSurvivalRecord(value: unknown): value is DraftSurvivalRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === 'string' &&
    typeof v.draftId === 'string' &&
    typeof v.personUserId === 'string' &&
    typeof v.draftTextLength === 'number' &&
    typeof v.finalTextLength === 'number' &&
    typeof v.similarity === 'number' &&
    typeof v.identical === 'boolean'
  );
}

export interface DraftSurvivalAggregate {
  count: number;
  /** Mean `similarity` across every record — "how much of a draft survives
   * to the posted version," aggregated, the metric the ticket names as
   * mattering more than the offline golden set. */
  meanSimilarity: number;
  /** Count of records where `identical` is true — posted completely
   * unedited. */
  identicalCount: number;
}

/** "Draft-survival, aggregated" — what a future report script (mirroring
 * `cost-report.ts`) or dashboard reads. Kept here, alongside the recording
 * logic, matching `costTracking.ts`'s own co-location of `record`/`readAll`
 * with `aggregate`/`aggregateByNode`. */
export function aggregateDraftSurvival(records: readonly DraftSurvivalRecord[]): DraftSurvivalAggregate {
  if (records.length === 0) return { count: 0, meanSimilarity: 0, identicalCount: 0 };
  const meanSimilarity = records.reduce((sum, r) => sum + r.similarity, 0) / records.length;
  const identicalCount = records.filter((r) => r.identical).length;
  return { count: records.length, meanSimilarity, identicalCount };
}
