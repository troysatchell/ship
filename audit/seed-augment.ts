#!/usr/bin/env npx tsx
/**
 * ShipShape audit — deterministic seed augmentation.
 *
 * The built-in seed (api/src/db/seed.ts) produces ~257 documents and 11 users,
 * short of the volumes audit/shipshape.config.yaml requires for the api-perf and
 * db-query categories (500 documents / 100 issues / 20 users / 10 sprints).
 *
 * This script tops the dataset up to those volumes. It is MEASUREMENT SCAFFOLDING:
 * it only inserts rows, never modifies application source. It must stay
 * deterministic and idempotent so that baseline and compare runs measure against
 * byte-identical data:
 *   - all randomness comes from a fixed-seed LCG (no Math.random)
 *   - all timestamps derive from a fixed epoch (no Date.now)
 *   - every row is keyed by a stable AUDIT- title so re-runs are no-ops
 *
 * Usage:  npx tsx audit/seed-augment.ts        (run AFTER pnpm db:seed)
 */
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '../api/.env.local') });

// ---- Targets (must match audit/shipshape.config.yaml `seed:`) ----
const TARGET_DOCUMENTS = 500;
const TARGET_USERS = 20;

// ---- Determinism ----
const SEED = 20260727;
const EPOCH = Date.parse('2026-01-05T09:00:00Z'); // fixed; never Date.now()

/** Mulberry32 — small, fast, fully deterministic PRNG. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(SEED);
const pick = <T>(arr: readonly T[], i: number): T => arr[i % arr.length]!;
/** Deterministic timestamp: EPOCH + n days, as an ISO string. */
const dayOffset = (n: number) => new Date(EPOCH + n * 86400000).toISOString();

const VERBS = ['Fix', 'Refactor', 'Add', 'Remove', 'Investigate', 'Document', 'Optimize', 'Harden'] as const;
const NOUNS = [
  'session expiry handling', 'document association lookup', 'sprint rollover job',
  'WebSocket reconnect backoff', 'issue list pagination', 'properties JSONB index usage',
  'audit log retention', 'CSV export path', 'person hierarchy query', 'editor autosave',
  'search ranking', 'weekly retro template', 'notification fanout', 'CSRF token refresh',
] as const;
const STATES = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

/** TipTap doc with `paras` paragraphs — mirrors the shape real content has. */
function makeContent(title: string, paras: number) {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: title }] },
      ...Array.from({ length: paras }, (_, i) => ({
        type: 'paragraph',
        content: [{
          type: 'text',
          text: `Paragraph ${i + 1}. ${pick(NOUNS, i * 3 + paras)} — context captured during audit seeding to give documents realistic body weight for query and payload measurement.`,
        }],
      })),
    ],
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set (expected api/.env.local)');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Match seed.ts's own lookup (api/src/db/seed.ts:65: `WHERE name = 'Ship Workspace'`)
    // rather than "oldest workspace" — a shared dev DB can carry leftover workspaces from
    // unrelated test runs (e.g. an OAuth-ticket test fixture) that are older by created_at
    // but have no program/project/sprint documents, which crashed this script downstream.
    const ws = await pool.query("SELECT id FROM workspaces WHERE name = 'Ship Workspace'");
    const workspaceId = ws.rows[0]?.id;
    if (!workspaceId) throw new Error('No "Ship Workspace" found — run `pnpm db:seed` first.');

    // ---------- 1. Users up to TARGET_USERS ----------
    const userCount = Number((await pool.query('SELECT count(*) FROM users')).rows[0].count);
    const usersNeeded = Math.max(0, TARGET_USERS - userCount);
    const passwordHash = await bcrypt.hash('admin123', 10);
    let usersAdded = 0;

    for (let i = 0; i < usersNeeded; i++) {
      const n = String(i + 1).padStart(2, '0');
      const email = `audit.user${n}@ship.local`;
      const name = `Audit User ${n}`;

      const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (existing.rows[0]) continue;

      const inserted = await pool.query(
        `INSERT INTO users (email, password_hash, name, last_workspace_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, passwordHash, name, workspaceId]
      );
      const userId = inserted.rows[0].id;

      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [workspaceId, userId]
      );
      // Person document, matching seed.ts (properties.user_id is the join key)
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, created_by, created_at, updated_at)
         VALUES ($1, 'person', $2, $3, $4, $5, $5)`,
        [workspaceId, name, JSON.stringify({ user_id: userId, email }), userId, dayOffset(i)]
      );
      usersAdded++;
    }
    console.log(`✅ Users: ${userCount} → ${userCount + usersAdded} (target ${TARGET_USERS})`);

    // ---------- 2. Documents up to TARGET_DOCUMENTS ----------
    const allUsers = (await pool.query(
      `SELECT u.id FROM users u
       JOIN workspace_memberships wm ON wm.user_id = u.id AND wm.workspace_id = $1
       ORDER BY u.email`,
      [workspaceId]
    )).rows;

    const programs = (await pool.query(
      `SELECT id FROM documents WHERE workspace_id = $1 AND document_type = 'program' ORDER BY title`,
      [workspaceId]
    )).rows;
    const projects = (await pool.query(
      `SELECT id FROM documents WHERE workspace_id = $1 AND document_type = 'project' ORDER BY title`,
      [workspaceId]
    )).rows;
    const sprints = (await pool.query(
      `SELECT id FROM documents WHERE workspace_id = $1 AND document_type = 'sprint' ORDER BY title`,
      [workspaceId]
    )).rows;

    const docCount = Number((await pool.query('SELECT count(*) FROM documents')).rows[0].count);
    const docsNeeded = Math.max(0, TARGET_DOCUMENTS - docCount);
    // ~64% issues / ~36% wiki: keeps issue-heavy list endpoints realistic while
    // still giving the wiki tree depth to traverse.
    const issuesToAdd = Math.round(docsNeeded * 0.64);
    const wikisToAdd = docsNeeded - issuesToAdd;

    const maxTicket = Number((await pool.query(
      `SELECT COALESCE(MAX(ticket_number), 0) AS m FROM documents WHERE workspace_id = $1`,
      [workspaceId]
    )).rows[0].m);

    let issuesAdded = 0;
    for (let i = 0; i < issuesToAdd; i++) {
      const title = `AUDIT-${String(i + 1).padStart(3, '0')} ${pick(VERBS, i)} ${pick(NOUNS, i * 7)}`;
      const existing = await pool.query(
        `SELECT id FROM documents WHERE workspace_id = $1 AND document_type = 'issue' AND title = $2`,
        [workspaceId, title]
      );
      if (existing.rows[0]) continue;

      const assignee = pick(allUsers, Math.floor(rng() * allUsers.length) + i);
      const properties = {
        state: pick(STATES, Math.floor(rng() * STATES.length) + i),
        priority: pick(PRIORITIES, Math.floor(rng() * PRIORITIES.length) + i),
        source: 'internal',
        assignee_id: assignee.id,
        estimate: 1 + (i % 8),
        feedback_status: null,
        rejection_reason: null,
      };
      const created = dayOffset(i % 180);

      const inserted = await pool.query(
        `INSERT INTO documents
           (workspace_id, document_type, title, content, properties, ticket_number, created_by, created_at, updated_at)
         VALUES ($1, 'issue', $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [workspaceId, title, JSON.stringify(makeContent(title, 2 + (i % 4))),
         JSON.stringify(properties), maxTicket + i + 1, assignee.id, created]
      );
      const issueId = inserted.rows[0].id;

      // Associations mirror seed.ts: every issue belongs to a program + project,
      // and most also to a sprint — so list queries traverse the junction table.
      const assoc: Array<[string, string]> = [
        [pick(programs, i).id, 'program'],
        [pick(projects, i * 3).id, 'project'],
      ];
      if (i % 4 !== 0 && sprints.length > 0) assoc.push([pick(sprints, i * 5).id, 'sprint']);

      for (const [relatedId, type] of assoc) {
        if (relatedId === issueId) continue;
        await pool.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [issueId, relatedId, type]
        );
      }
      issuesAdded++;
    }

    // Wiki docs — every 4th is nested under the previous one to give the tree depth.
    let wikisAdded = 0;
    let lastRootWikiId: string | null = null;
    for (let i = 0; i < wikisToAdd; i++) {
      const title = `AUDIT Wiki ${String(i + 1).padStart(3, '0')}: ${pick(NOUNS, i * 5)}`;
      const existing = await pool.query(
        `SELECT id FROM documents WHERE workspace_id = $1 AND document_type = 'wiki' AND title = $2`,
        [workspaceId, title]
      );
      if (existing.rows[0]) continue;

      const nest = i % 4 !== 0 && lastRootWikiId !== null;
      const author = pick(allUsers, i * 2);
      const inserted = await pool.query(
        `INSERT INTO documents
           (workspace_id, document_type, title, content, parent_id, position, created_by, created_at, updated_at)
         VALUES ($1, 'wiki', $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [workspaceId, title, JSON.stringify(makeContent(title, 3 + (i % 6))),
         nest ? lastRootWikiId : null, i, author.id, dayOffset(i % 180)]
      );
      if (!nest) lastRootWikiId = inserted.rows[0].id;
      wikisAdded++;
    }

    console.log(`✅ Documents: ${docCount} → ${docCount + issuesAdded + wikisAdded} (target ${TARGET_DOCUMENTS})`);
    console.log(`   +${issuesAdded} issues, +${wikisAdded} wiki`);

    const final = await pool.query(
      `SELECT document_type, count(*)::int AS n FROM documents GROUP BY 1 ORDER BY 2 DESC`
    );
    console.table(final.rows);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('seed-augment failed:', err);
  process.exit(1);
});
