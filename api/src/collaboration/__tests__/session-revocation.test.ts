import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import crypto from 'crypto'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { pool } from '../../db/client.js'
// Namespace import on purpose: this file must be runnable against the UNFIXED
// module to confirm it goes red for the right reason. A named import of an
// export that does not exist yet fails at module load (a broken test, not a red
// one); a namespace import just yields undefined and lets the assertions speak.
import * as collab from '../index.js'

/**
 * TRO-189 / ERR-2 — session revocation is not enforced on live collaboration sockets.
 *
 * The socket was authenticated exactly once, during the HTTP upgrade
 * (`api/src/collaboration/index.ts`, `server.on('upgrade')`). Nothing re-checked
 * it afterwards, so deleting the session row — logout, revocation, expiry — left
 * the socket writing to `documents` indefinitely while REST correctly 401'd.
 *
 * These tests drive the REAL collaboration server over a REAL WebSocket and
 * assert on the database, not on a mock.
 */

const MESSAGE_SYNC = 0
// Application-range close code the server uses for "your session is gone".
// Inlined rather than imported so this file also loads against the unfixed module.
const EXPECTED_CLOSE_CODE = 4401

// persistDocument() is debounced by 2s; give writes room to land (or to fail to).
const PERSIST_WAIT_MS = 4_000
const REVALIDATION_INTERVAL_MS = 200

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Build a Yjs sync-update frame exactly as a y-websocket client would. */
function encodeUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

describe('Collaboration session revocation (TRO-189 / ERR-2)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  let server: Server
  let handle: { stopSessionRevalidation?: () => void } | undefined
  let port: number
  let workspaceId: string
  let userId: string

  const openSockets: WebSocket[] = []

  beforeAll(async () => {
    const workspace = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Revocation Test ${testRunId}`]
    )
    workspaceId = workspace.rows[0].id

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Revocation User') RETURNING id`,
      [`revocation-${testRunId}@test.local`]
    )
    userId = user.rows[0].id

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [workspaceId, userId]
    )

    server = createServer()
    // A short revalidation interval keeps the test fast. Production default is
    // DEFAULT_SESSION_REVALIDATION_INTERVAL_MS.
    handle = collab.setupCollaboration(server, {
      sessionRevalidationIntervalMs: REVALIDATION_INTERVAL_MS,
    }) as { stopSessionRevalidation?: () => void } | undefined
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    for (const ws of openSockets) {
      try { ws.terminate() } catch { /* already gone */ }
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

  async function createDocument(title: string): Promise<string> {
    const result = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'wiki', $2, 'workspace', $3) RETURNING id`,
      [workspaceId, title, userId]
    )
    return result.rows[0].id
  }

  async function documentContent(docId: string): Promise<string> {
    const result = await pool.query('SELECT content FROM documents WHERE id = $1', [docId])
    const content = result.rows[0]?.content
    return content == null ? '' : JSON.stringify(content)
  }

  /** Poll rather than sleep: persistDocument() is debounced, not instant. */
  async function waitForContent(docId: string, marker: string, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let content = await documentContent(docId)
    while (Date.now() < deadline && !content.includes(marker)) {
      await delay(200)
      content = await documentContent(docId)
    }
    return content
  }

  interface TestClient {
    ws: WebSocket
    doc: Y.Doc
    /** Type text into the local doc and push the resulting update at the server. */
    type: (text: string) => void
    closeInfo: () => { closed: boolean; code: number | null }
  }

  async function connect(docId: string, sessionId: string): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/collaboration/wiki:${docId}`, {
      headers: { cookie: `session_id=${sessionId}` },
    })
    openSockets.push(ws)

    let closed = false
    let code: number | null = null
    ws.on('close', (c: number) => { closed = true; code = c })

    // Wait for the server's first frame, not just for `open`. The server
    // registers the connection and sends sync step 1 only after an async
    // document load, so `open` alone does not mean the server is ready.
    const firstServerFrame = new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve())
      ws.once('error', reject)
      setTimeout(() => reject(new Error('server sent no frame within 10s of connecting')), 10_000)
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await firstServerFrame

    const doc = new Y.Doc()
    const pending: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => pending.push(update))

    return {
      ws,
      doc,
      type: (text: string) => {
        pending.length = 0
        const fragment = doc.getXmlFragment('default')
        doc.transact(() => {
          const paragraph = new Y.XmlElement('paragraph')
          fragment.push([paragraph])
          const node = new Y.XmlText()
          paragraph.push([node])
          node.insert(0, text)
        })
        for (const update of pending) {
          // Attempt the write unconditionally. On a revoked socket this is
          // exactly what an attacker's still-open editor would do.
          try {
            ws.send(encodeUpdateMessage(update))
          } catch {
            /* socket already closed — the write never leaves the client */
          }
        }
      },
      closeInfo: () => ({ closed, code }),
    }
  }

  async function waitForClose(client: TestClient, timeoutMs = 6_000): Promise<{ closed: boolean; code: number | null }> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const info = client.closeInfo()
      if (info.closed) return info
      await delay(50)
    }
    return client.closeInfo()
  }

  it('persists edits from a socket whose session is still valid (control)', async () => {
    const sessionId = await createSession()
    const docId = await createDocument('Revocation control doc')
    const client = await connect(docId, sessionId)

    const marker = `AUTHORIZED_${testRunId}`
    client.type(marker)

    expect(
      await waitForContent(docId, marker),
      'an authorized live socket must still be able to write — otherwise the revocation assertions below prove nothing'
    ).toContain(marker)

    client.ws.close()
  }, 30_000)

  it('closes a live collaboration socket once its session row is deleted', async () => {
    const sessionId = await createSession()
    const docId = await createDocument('Revocation close doc')
    const client = await connect(docId, sessionId)

    expect(client.closeInfo().closed, 'socket should be open before revocation').toBe(false)

    // Revocation: exactly what POST /api/auth/logout and an admin revocation do.
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId])

    const info = await waitForClose(client)
    expect(
      info.closed,
      'a collaboration socket whose session was deleted must be disconnected, not left open with write access (ERR-2)'
    ).toBe(true)
    expect(info.code).toBe(EXPECTED_CLOSE_CODE)
  }, 30_000)

  it('closes a live collaboration socket once its session passes the inactivity window', async () => {
    const sessionId = await createSession()
    const docId = await createDocument('Revocation expiry doc')
    const client = await connect(docId, sessionId)

    // Force the session outside the 15-minute inactivity window, the same state
    // that makes every REST call 401.
    await pool.query(
      `UPDATE sessions SET last_activity = now() - interval '20 minutes' WHERE id = $1`,
      [sessionId]
    )

    const info = await waitForClose(client)
    expect(
      info.closed,
      'an expired session must not keep a live socket alive while REST calls 401 (ERR-2 / probe6.4)'
    ).toBe(true)
    expect(info.code).toBe(EXPECTED_CLOSE_CODE)
  }, 30_000)

  it('does not persist document writes attempted after the session is revoked', async () => {
    const sessionId = await createSession()
    const docId = await createDocument('Revocation write doc')
    const client = await connect(docId, sessionId)

    const before = `BEFORE_REVOKE_${testRunId}`
    const after = `AFTER_REVOKE_${testRunId}`

    client.type(before)
    expect(await waitForContent(docId, before), 'pre-revocation write should land').toContain(before)

    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId])
    await waitForClose(client)

    // The revoked editor keeps typing, exactly as a logged-out user's open tab would.
    client.type(after)
    await delay(PERSIST_WAIT_MS)

    const content = await documentContent(docId)
    expect(content, 'the earlier authorized edit must survive').toContain(before)
    expect(
      content,
      'a write made after the session was revoked must never reach the documents table (ERR-2 / probe7c)'
    ).not.toContain(after)
  }, 40_000)

  it('closes sockets for a session immediately, without waiting for the sweep', async () => {
    const sessionId = await createSession()
    const docId = await createDocument('Revocation logout doc')
    const client = await connect(docId, sessionId)

    // This is the mechanism POST /api/auth/logout uses so a logout takes effect
    // at once rather than up to one revalidation interval later.
    const closeSockets = collab.closeSocketsForSession
    expect(typeof closeSockets, 'collaboration module must expose closeSocketsForSession for the logout path').toBe('function')

    const closedCount = closeSockets(sessionId, 'Logged out')
    expect(closedCount).toBeGreaterThanOrEqual(1)

    const info = await waitForClose(client, 2_000)
    expect(info.closed).toBe(true)
    expect(info.code).toBe(EXPECTED_CLOSE_CODE)
  }, 30_000)
})
