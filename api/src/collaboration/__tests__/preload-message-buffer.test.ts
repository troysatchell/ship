import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import crypto from 'crypto'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { pool } from '../../db/client.js'
// Namespace import on purpose (same rationale as malformed-frames.test.ts):
// MAX_PRELOAD_BUFFER_BYTES / WS_CLOSE_PRELOAD_BUFFER_FULL are new exports this
// fix introduces. A named import of an export that does not exist yet fails
// at module load — a broken test, not a red one. A namespace import lets this
// file still run against the unfixed module and fail with a real assertion.
import * as collab from '../index.js'

/**
 * TRO-284 / ERR-11 — inbound frames must not be dropped while a document is
 * still loading.
 *
 * `wss.on('connection')` awaits a database round trip (getOrCreateDoc()). Before
 * this fix, `ws.on('message')` was registered only after that `await`, so a
 * frame arriving in that window had no listener and Node's EventEmitter
 * silently discarded it. A y-websocket client sends sync step 1 on the very
 * first tick after 'open' — exactly the shape of frame this file sends.
 *
 * Both tests below force a REAL, non-mocked load delay by seeding the target
 * document with a large `content` value: fetching and detoasting a large row
 * measurably slows the single query loadDoc() issues (~70-110ms observed
 * locally against this repo's dev Postgres for a 20MB value, versus well
 * under 1ms for a small row). That is long enough to reliably land a frame —
 * or flood one past the buffer bound — inside the load window without
 * needing to mock timing, the database, or any internal function.
 */

const MESSAGE_SYNC = 0

function encodeUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Collaboration preload message buffer (TRO-284 / ERR-11)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  let server: Server
  let handle: { stopSessionRevalidation?: () => void } | undefined
  let port: number
  let workspaceId: string
  let userId: string

  const openSockets: WebSocket[] = []

  beforeAll(async () => {
    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `Preload Buffer Test ${testRunId}`,
    ])
    workspaceId = workspace.rows[0].id

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', 'Preload Buffer User') RETURNING id`,
      [`preload-buffer-${testRunId}@test.local`]
    )
    userId = user.rows[0].id

    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [
      workspaceId,
      userId,
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
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId])
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM users WHERE id = $1', [userId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
  })

  async function createSession(): Promise<string> {
    const sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
      [sessionId, userId, workspaceId]
    )
    return sessionId
  }

  /**
   * A document whose `content` column is deliberately large. It is not a
   * valid TipTap doc shape, so `loadDoc()`'s conversion is skipped — this
   * exists purely to make the one SELECT `loadDoc()` issues measurably slow, a
   * real (unmocked) way to widen the load window long enough for both tests
   * below to reliably land inside it.
   */
  async function createSlowLoadingDocument(title: string): Promise<string> {
    const paddingBytes = 20 * 1024 * 1024
    const content = { padding: 'x'.repeat(paddingBytes) }
    const result = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, visibility, created_by)
       VALUES ($1, 'wiki', $2, $3, 'workspace', $4) RETURNING id`,
      [workspaceId, title, JSON.stringify(content), userId]
    )
    return result.rows[0].id
  }

  interface YjsStateRow {
    yjs_state: Buffer | null
  }

  /**
   * Decodes `yjs_state` rather than reading `content` back: `content` still
   * holds the large seed padding until the debounced persist overwrites it, so
   * polling it would re-transfer ~20MB on every poll. `yjs_state` stays NULL
   * until the real (small) edit is persisted.
   */
  async function readYjsState(docId: string): Promise<string> {
    const result = await pool.query<YjsStateRow>('SELECT yjs_state FROM documents WHERE id = $1', [docId])
    const state = result.rows[0]?.yjs_state
    if (!state) return ''
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    return doc.getXmlFragment('default').toString()
  }

  async function waitForYjsText(docId: string, marker: string, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let text = await readYjsState(docId)
    while (Date.now() < deadline && !text.includes(marker)) {
      // review-pattern-ok: bounded poll, not a fixed wait — re-checks a real
      // condition (the marker's presence) against a real deadline, and exits
      // the instant the condition holds. Same shape as the pre-existing
      // waitForContent() in session-revocation.test.ts.
      await delay(150)
      text = await readYjsState(docId)
    }
    return text
  }

  /** Builds a single-paragraph Yjs update frame carrying `text`, as a real y-websocket client would. */
  function buildEditFrame(text: string): Uint8Array {
    const doc = new Y.Doc()
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))
    doc.transact(() => {
      const fragment = doc.getXmlFragment('default')
      const paragraph = new Y.XmlElement('paragraph')
      fragment.push([paragraph])
      const node = new Y.XmlText()
      paragraph.push([node])
      node.insert(0, text)
    })
    const update = updates[0]
    if (!update) {
      throw new Error('expected the transact() above to produce exactly one Yjs update')
    }
    return encodeUpdateMessage(update)
  }

  it("processes a frame sent in the same tick as 'open' instead of dropping it", async () => {
    const docId = await createSlowLoadingDocument('Preload buffer same-tick doc')
    const sessionId = await createSession()
    const marker = `SAMETICK_${testRunId}`
    const frame = buildEditFrame(marker)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/collaboration/wiki:${docId}`, {
      headers: { cookie: `session_id=${sessionId}` },
    })
    openSockets.push(ws)

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // The write this test is named for: sent synchronously, in the SAME
        // tick as 'open'. Before this fix, nothing was listening yet and this
        // frame would be silently discarded by Node's EventEmitter.
        ws.send(frame)
        resolve()
      })
      ws.on('error', reject)
    })

    const text = await waitForYjsText(docId, marker)
    expect(
      text,
      `a frame sent in the same tick as 'open' must be processed, not silently dropped while the document loads (ERR-11). yjs text so far: ${text.slice(0, 200)}`
    ).toContain(marker)

    ws.close()
  }, 30_000)

  it('closes the socket, rather than growing the buffer, once preload frames exceed the bound', async () => {
    const docId = await createSlowLoadingDocument('Preload buffer overflow doc')
    const sessionId = await createSession()

    const ws = new WebSocket(`ws://127.0.0.1:${port}/collaboration/wiki:${docId}`, {
      headers: { cookie: `session_id=${sessionId}` },
    })
    openSockets.push(ws)

    let closeCode: number | null = null
    let closeReason = ''
    ws.on('close', (code: number, reason: Buffer) => {
      closeCode = code
      closeReason = reason.toString()
    })

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // Flood well past MAX_PRELOAD_BUFFER_BYTES in one synchronous burst —
        // all of it lands while the slow load above is still in flight.
        const frameSize = 64 * 1024
        const framesNeeded = Math.ceil(((collab.MAX_PRELOAD_BUFFER_BYTES ?? 0) * 2) / frameSize)
        const junkFrame = encodeUpdateMessage(new Uint8Array(frameSize))
        for (let i = 0; i < framesNeeded; i++) {
          ws.send(junkFrame)
        }
        resolve()
      })
      ws.on('error', reject)
    })

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && closeCode === null) {
      // review-pattern-ok: bounded poll on the socket's own 'close' event
      // handler having fired, not a fixed wait — exits the instant closeCode
      // is set, same shape as waitForClose() in session-revocation.test.ts.
      await delay(100)
    }

    expect(
      closeCode,
      `socket should have been closed for exceeding the preload buffer bound; observed close reason: ${closeReason}`
    ).toBe(collab.WS_CLOSE_PRELOAD_BUFFER_FULL)
  }, 30_000)
})
