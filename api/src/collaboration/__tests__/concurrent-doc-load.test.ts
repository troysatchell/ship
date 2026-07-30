import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import crypto from 'crypto'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import { pool } from '../../db/client.js'
// Namespace import on purpose (same rationale as malformed-frames.test.ts):
// getOrCreateDoc() was not exported before this fix, so a named import would
// fail at module load against the pre-fix module — a broken test, not a red
// one. A namespace import lets this file still run against that module and
// fail with a real assertion instead.
import * as collab from '../index.js'

/**
 * TRO-285 / ERR-12 — a second connection must never observe a document
 * between "published" and "loaded".
 *
 * `getOrCreateDoc()` used to publish a brand-new Y.Doc into the shared `docs`
 * map BEFORE awaiting the database read / JSON→Yjs conversion, and attached
 * `doc.on('update')` only afterwards. A second caller arriving in that window
 * found the doc already cached — so it triggered no load of its own — and got
 * back a doc that was still empty, with no listener yet attached to notice
 * when the real content landed a moment later.
 */

const MESSAGE_SYNC = 0
const SYNC_STEP_2 = 1
const REMOTE_ORIGIN = { remote: true }

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

describe('Collaboration concurrent document load (TRO-285 / ERR-12)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  let server: Server
  let handle: { stopSessionRevalidation?: () => void } | undefined
  let port: number
  let workspaceId: string
  let userAId: string
  let userBId: string

  const openSockets: WebSocket[] = []

  beforeAll(async () => {
    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `Concurrent Doc Load Test ${testRunId}`,
    ])
    workspaceId = workspace.rows[0].id

    const userA = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Concurrent Load User A') RETURNING id`,
      [`concurrent-load-a-${testRunId}@test.local`]
    )
    userAId = userA.rows[0].id

    const userB = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Concurrent Load User B') RETURNING id`,
      [`concurrent-load-b-${testRunId}@test.local`]
    )
    userBId = userB.rows[0].id

    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [
      workspaceId,
      userAId,
    ])
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [
      workspaceId,
      userBId,
    ])

    server = createServer()
    handle = collab.setupCollaboration(server) as { stopSessionRevalidation?: () => void } | undefined
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    for (const ws of openSockets) {
      try {
        ws.terminate()
      } catch {
        /* already gone */
      }
    }
    handle?.stopSessionRevalidation?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [[userAId, userBId]])
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userAId, userBId]])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
  })

  async function createSession(userId: string): Promise<string> {
    const sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
      [sessionId, userId, workspaceId]
    )
    return sessionId
  }

  async function createDocument(title: string, seedText: string): Promise<string> {
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: seedText }] }] }
    const result = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, visibility, created_by)
       VALUES ($1, 'wiki', $2, $3, 'workspace', $4) RETURNING id`,
      [workspaceId, title, JSON.stringify(content), userAId]
    )
    return result.rows[0].id
  }

  /**
   * A document whose seeded text is padded to ~20MB. Still a VALID TipTap doc
   * shape (unlike preload-message-buffer.test.ts's padding doc), so
   * jsonToYjs() genuinely runs — this is what makes loadDoc()'s one SELECT
   * measurably slower than a small row (real, unmocked; same technique as
   * preload-message-buffer.test.ts), widening the window long enough for two
   * real, simultaneously-opened sockets to reliably both land inside it.
   */
  async function createSlowLoadingDocument(title: string, seedMarker: string): Promise<string> {
    const paddedText = seedMarker + 'x'.repeat(20 * 1024 * 1024)
    return createDocument(title, paddedText)
  }

  /**
   * Connects one client, replies to the sync handshake, and resolves with the
   * XmlFragment text once sync step 2 (the server's state) arrives. Read-only
   * on purpose — this proves what a client RECEIVES, which is exactly what
   * ERR-12 broke for a second concurrent connection.
   */
  function connectAndCaptureFragmentText(docId: string, sessionId: string, timeoutMs = 20_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const doc = new Y.Doc()
      const ws = new WebSocket(`ws://127.0.0.1:${port}/collaboration/wiki:${docId}`, {
        headers: { cookie: `session_id=${sessionId}` },
      })
      openSockets.push(ws)

      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new Error(`timed out waiting for sync step 2 for doc ${docId}`))
      }, timeoutMs)
      timer.unref?.()

      ws.on('close', (code: number, reason: Buffer) => {
        // Reject immediately on an unexpected close instead of waiting out the
        // full timeout — a closed socket can never deliver sync step 2, so
        // there's no reason to wait, and the close code/reason is a much more
        // actionable failure message than a bare timeout.
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`socket closed before sync step 2 arrived (code=${code}, reason=${reason.toString()})`))
      })

      ws.on('message', (data: Buffer) => {
        const decoder = decoding.createDecoder(new Uint8Array(data))
        const messageType = decoding.readVarUint(decoder)
        if (messageType !== MESSAGE_SYNC) return

        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        let syncType: number
        try {
          syncType = syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE_ORIGIN)
        } catch (error) {
          settled = true
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (encoding.length(encoder) > 1 && ws.readyState === WebSocket.OPEN) {
          ws.send(encoding.toUint8Array(encoder))
        }
        if (syncType === SYNC_STEP_2) {
          settled = true
          clearTimeout(timer)
          resolve(doc.getXmlFragment('default').toString())
        }
      })
      ws.on('error', (err: Error) => {
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      ws.on('open', () => {
        ws.send(encodeSyncStep1(doc))
      })
    })
  }

  it('two concurrent loads of the same not-yet-cached document both resolve to a fully loaded doc', async () => {
    const seedMarker = `DIRECT_LOAD_${testRunId}`
    const docId = await createDocument('Direct concurrent getOrCreateDoc doc', seedMarker)
    const docName = `wiki:${docId}`

    // First call: starts the real load (a database round trip) but is
    // deliberately not awaited yet.
    const firstCallPromise = collab.getOrCreateDoc(docName)

    // Second call, issued synchronously right after the first — in the same
    // JS turn, before the first call's `await pool.query(...)` has any chance
    // to settle (that requires real I/O, which cannot complete synchronously).
    //
    // Pre-fix, `docs` mapped the doc name to the Y.Doc itself, published
    // before the load. This second call would find that (still-empty) doc
    // already in the map and return it immediately — an ERR-12 reproduction.
    // Post-fix, `docs` maps the doc name to the LOAD PROMISE, so this second
    // call returns the SAME promise as the first, and awaiting it waits for
    // the entire load, not just a synchronous map lookup.
    const secondCallPromise = collab.getOrCreateDoc(docName)

    const docFromSecondCall = await secondCallPromise
    const text = docFromSecondCall.getXmlFragment('default').toString()

    expect(
      text,
      `a second concurrent caller must receive a FULLY LOADED doc, not one still mid-load (ERR-12). fragment so far: ${text.slice(0, 200)}`
    ).toContain(seedMarker)

    const docFromFirstCall = await firstCallPromise
    expect(
      docFromFirstCall,
      'both concurrent callers must resolve to the exact same Y.Doc instance'
    ).toBe(docFromSecondCall)
  }, 30_000)

  it('rejects and evicts a failed load so the next connection retries with a fresh query', async () => {
    // A syntactically invalid UUID makes Postgres itself reject the query
    // (a real "invalid input syntax for type uuid" error) — a genuine
    // database-read failure, not a mock standing in for one.
    const docName = `wiki:not-a-valid-uuid-${testRunId}`

    const querySpy = vi.spyOn(pool, 'query')
    try {
      await expect(collab.getOrCreateDoc(docName)).rejects.toThrow(/invalid input syntax for type uuid/i)

      // If the failed entry were left in the `docs` map, this second call
      // would return the SAME (already-rejected) promise without issuing any
      // new query. Observing a fresh query is the proof of eviction.
      await expect(collab.getOrCreateDoc(docName)).rejects.toThrow(/invalid input syntax for type uuid/i)

      const loadQueries = querySpy.mock.calls.filter(
        ([text]) => typeof text === 'string' && text.includes('SELECT yjs_state, content FROM documents WHERE id = $1')
      )
      expect(
        loadQueries.length,
        'a failed load must evict its map entry so the next connection retries with a fresh query rather than reusing the cached rejection'
      ).toBe(2)
    } finally {
      querySpy.mockRestore()
    }
  }, 30_000)

  it('two clients connecting simultaneously to a not-yet-loaded document both receive full state', async () => {
    const seedMarker = `TWO_SOCKET_${testRunId}`
    const docId = await createSlowLoadingDocument('Two-socket concurrent load doc', seedMarker)
    const [sessionA, sessionB] = await Promise.all([createSession(userAId), createSession(userBId)])

    // Both connections are initiated in the same synchronous block (neither
    // `await`ed before the other starts) so they race the same document load,
    // widened by createSlowLoadingDocument()'s padded content — the real
    // symptom this ticket describes: "the weekly plan/retro opened blank" for
    // whichever client's connection lands in the window.
    const [textA, textB] = await Promise.all([
      connectAndCaptureFragmentText(docId, sessionA),
      connectAndCaptureFragmentText(docId, sessionB),
    ])

    expect(textA, `client A must receive the seeded content, not a blank document (ERR-12)`).toContain(seedMarker)
    expect(textB, `client B must receive the seeded content, not a blank document (ERR-12)`).toContain(seedMarker)
  }, 30_000)
})
