import { describe, expect, it, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateDraftSurvival,
  computeDraftSurvival,
  FileDraftSurvivalTracker,
  type DraftSurvivalRecord,
} from '../draftSurvival.js';

describe('computeDraftSurvival', () => {
  it('reports identical: true and similarity 1 when the posted text exactly matches the draft', () => {
    const record = computeDraftSurvival(
      'draft-1',
      'user-a',
      'Moved "X" to In Review.',
      'Moved "X" to In Review.',
      () => new Date('2026-08-05T00:00:00.000Z')
    );
    expect(record.identical).toBe(true);
    expect(record.similarity).toBe(1);
    expect(record.draftId).toBe('draft-1');
    expect(record.personUserId).toBe('user-a');
    expect(record.timestamp).toBe('2026-08-05T00:00:00.000Z');
    expect(record.draftTextLength).toBe('Moved "X" to In Review.'.length);
    expect(record.finalTextLength).toBe('Moved "X" to In Review.'.length);
  });

  it('reports identical: false with a partial similarity for a lightly edited draft', () => {
    const record = computeDraftSurvival(
      'draft-2',
      'user-a',
      'Moved "X" to In Review.',
      'Moved "X" to In Review. Also fixed a typo.'
    );
    expect(record.identical).toBe(false);
    expect(record.similarity).toBeGreaterThan(0);
    expect(record.similarity).toBeLessThan(1);
  });

  it('reports a low similarity for a draft rewritten from scratch — the "bad draft" case', () => {
    const record = computeDraftSurvival(
      'draft-3',
      'user-a',
      'Moved "Build issue assignment flow" to In Review after finishing the implementation.',
      'Quiet week, mostly in meetings.'
    );
    expect(record.identical).toBe(false);
    expect(record.similarity).toBeLessThan(0.2);
  });
});

describe('FileDraftSurvivalTracker', () => {
  const scratchPath = () => join(tmpdir(), `tro338-draft-survival-${randomBytes(6).toString('hex')}.jsonl`);
  const created: string[] = [];

  afterEach(() => {
    for (const p of created.splice(0)) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('records an entry and reads it back', async () => {
    const path = scratchPath();
    created.push(path);
    const tracker = new FileDraftSurvivalTracker({ ledgerPath: path });

    const record = computeDraftSurvival('draft-1', 'user-a', 'original', 'original');
    await tracker.record(record);

    const all = tracker.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(record);
  });

  it('appends multiple records without clobbering earlier ones', async () => {
    const path = scratchPath();
    created.push(path);
    const tracker = new FileDraftSurvivalTracker({ ledgerPath: path });

    await tracker.record(computeDraftSurvival('draft-1', 'user-a', 'a', 'a'));
    await tracker.record(computeDraftSurvival('draft-2', 'user-b', 'b text here', 'totally different text'));

    expect(tracker.readAll()).toHaveLength(2);
  });

  it('readAll returns [] for a ledger that does not exist yet', () => {
    const tracker = new FileDraftSurvivalTracker({ ledgerPath: scratchPath() });
    expect(tracker.readAll()).toEqual([]);
  });

  it('skips a malformed line rather than throwing', async () => {
    const path = scratchPath();
    created.push(path);
    const tracker = new FileDraftSurvivalTracker({ ledgerPath: path });
    await tracker.record(computeDraftSurvival('draft-1', 'user-a', 'a', 'a'));

    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, 'not valid json\n', 'utf8');

    expect(tracker.readAll()).toHaveLength(1);
  });
});

describe('aggregateDraftSurvival', () => {
  function rec(overrides: Partial<DraftSurvivalRecord>): DraftSurvivalRecord {
    return {
      timestamp: '2026-08-05T00:00:00.000Z',
      draftId: 'd',
      personUserId: 'u',
      draftTextLength: 10,
      finalTextLength: 10,
      similarity: 1,
      identical: true,
      ...overrides,
    };
  }

  it('returns zeroed stats for an empty record set', () => {
    expect(aggregateDraftSurvival([])).toEqual({ count: 0, meanSimilarity: 0, identicalCount: 0 });
  });

  it('computes mean similarity and identical count across records', () => {
    const result = aggregateDraftSurvival([
      rec({ similarity: 1, identical: true }),
      rec({ similarity: 0.5, identical: false }),
      rec({ similarity: 0, identical: false }),
    ]);
    expect(result.count).toBe(3);
    expect(result.identicalCount).toBe(1);
    expect(result.meanSimilarity).toBeCloseTo(0.5, 5);
  });
});
