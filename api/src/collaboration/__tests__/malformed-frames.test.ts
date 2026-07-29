import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createServer, Server } from 'http'
import net, { AddressInfo } from 'net'
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
 * TRO-276 / ERR-10 — one malformed WebSocket frame killed the whole API.
 *
 * `handleMessage()` in api/src/collaboration/index.ts decodes attacker-controlled
 * bytes with raw lib0 readers. Those readers throw on truncated or malformed
 * input (`Unexpected end of array`, `Invalid typed array length`). The call site
 * is a `ws` 'message' listener — an I/O callback — so a synchronous throw there
 * escapes to the process. With no `process.on('uncaughtException')` anywhere in
 * the repo, Node's default applies: the process terminates. Any authenticated
 * user could take the API down for everyone with a handful of bytes.
 *
 * These tests drive the REAL collaboration server over REAL WebSockets.
 *
 * How "the process survives" is observed
 * -------------------------------------
 * A test cannot watch its own process die. What it CAN observe is the exact
 * precondition for the death: an exception reaching the process level. Node
 * terminates on `uncaughtException` only when no listener is registered, so
 * "zero exceptions reached the process level" and "the process cannot have been
 * killed by this frame" are the same statement. Each case therefore installs its
 * own `uncaughtException` / `unhandledRejection` recorder for the duration of the
 * frame (temporarily displacing vitest's, which is restored afterwards) and
 * asserts it captured nothing. Anything it does capture is reported as a failure,
 * so nothing is swallowed.
 *
 * The last case closes the loop end-to-end: after every malformed frame has been
 * fired, an unrelated co-tenant socket must still work and a brand-new client
 * must still be able to connect and persist an edit. A dead process cannot do
 * either.
 */

const MESSAGE_SYNC = 0

/**
 * The five frames observed to produce an uncaught exception against a running
 * server (audit ERR-10). Byte sequences, not names, because the point is that
 * these are what an attacker types.
 */
const CRASHING_FRAMES: Array<{ label: string; bytes: number[]; observedError: string }> = [
  { label: 'empty frame', bytes: [], observedError: 'Unexpected end of array' },
  { label: 'sync step1 with a length prefix longer than the payload', bytes: [0, 0, 5, 1], observedError: 'Invalid typed array length: 5' },
  { label: 'awareness message with no payload', bytes: [1], observedError: 'Unexpected end of array' },
  { label: 'awareness with a length prefix longer than the payload', bytes: [1, 5, 1], observedError: 'Invalid typed array length: 5' },
  { label: 'awareness whose inner update is a truncated varint', bytes: [1, 3, 1, 200, 200], observedError: 'Unexpected end of array' },
]

/**
 * Frames that were already survivable and must STAY survivable. They guard
 * against an over-broad fix that hangs up on traffic the protocol tolerates:
 * `[0,1]` is a truncated sync step 2, which y-protocols catches internally, and
 * `[9,9,9]` is an unknown message type, which the switch ignores by design.
 */
const BENIGN_FRAMES: Array<{ label: string; bytes: number[] }> = [
  { label: 'truncated sync step 2 (y-protocols catches this itself)', bytes: [0, 1] },
  { label: 'unknown message type', bytes: [9, 9, 9] },
]

/** Long enough that the revalidation sweep never runs mid-test and confounds ERR-2 with ERR-10. */
const REVALIDATION_INTERVAL_MS = 300_000

/** Deadline for the offending socket to be closed by the server. */
const CLOSE_TIMEOUT_MS = 5_000

/** Deadline for a write to reach the documents table (persistDocument is debounced 2s). */
const PERSIST_TIMEOUT_MS = 15_000

/** Interval of the bounded condition poll below. Not a synchronisation sleep — see waitUntil(). */
const POLL_INTERVAL_MS = 25

/**
 * The RFC 6455 protocol-error code the server must use for a frame it cannot
 * decode. Inlined rather than imported so this file still loads against the
 * unfixed module (a named import of an export that does not exist yet fails at
 * module load — a broken test, not a red one). A dedicated case below pins it
 * against the module's exported constant so the two cannot drift.
 */
const EXPECTED_CLOSE_CODE = 1002

/**
 * Bounded condition poll: returns as soon as the condition holds.
 *
 * This is the replacement for a fixed sleep, not an instance of one (TEST-11 /
 * TRO-233). There is genuinely no event to await here — `persistDocument()` is
 * debounced *inside* the server and emits no external signal — so reading until
 * the value appears is the honest mechanism. It returns the observed value either
 * way, so the caller asserts on the value and a timeout surfaces as a real
 * assertion about content rather than as "waited long enough".
 */
async function waitUntil<T>(
  read: () => Promise<T>,
  holds: (value: T) => boolean,
  timeoutMs = PERSIST_TIMEOUT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!holds(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    value = await read()
  }
  return value
}

/** Build a Yjs sync-update frame exactly as a y-websocket client would. */
function encodeUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

/**
 * Records anything that reaches the process level, and keeps this test process
 * alive while doing so.
 *
 * Vitest's own handlers are saved and restored around each window. Removing them
 * for the window is what lets a red run report a clean assertion instead of
 * tearing the whole file down, and nothing is hidden: every captured exception
 * becomes part of the failure message below.
 */
class ProcessCrashRecorder {
  readonly captured: Array<{ kind: 'uncaughtException' | 'unhandledRejection'; error: unknown }> = []

  private savedUncaught: NodeJS.UncaughtExceptionListener[] = []
  private savedRejection: NodeJS.UnhandledRejectionListener[] = []
  private watching = false

  private readonly onUncaught = (error: unknown) => {
    this.captured.push({ kind: 'uncaughtException', error })
  }

  private readonly onRejection = (error: unknown) => {
    this.captured.push({ kind: 'unhandledRejection', error })
  }

  start(): void {
    if (this.watching) return
    this.watching = true
    this.captured.length = 0
    this.savedUncaught = process.listeners('uncaughtException')
    this.savedRejection = process.listeners('unhandledRejection')
    process.removeAllListeners('uncaughtException')
    process.removeAllListeners('unhandledRejection')
    process.on('uncaughtException', this.onUncaught)
    process.on('unhandledRejection', this.onRejection)
  }

  stop(): void {
    if (!this.watching) return
    this.watching = false
    process.off('uncaughtException', this.onUncaught)
    process.off('unhandledRejection', this.onRejection)
    for (const listener of this.savedUncaught) process.on('uncaughtException', listener)
    for (const listener of this.savedRejection) process.on('unhandledRejection', listener)
    this.savedUncaught = []
    this.savedRejection = []
  }

  summary(): string {
    if (this.captured.length === 0) return 'none'
    return this.captured.map((c) => `${c.kind} -> ${describeError(c.error)}`).join('; ')
  }
}

describe('Collaboration malformed-frame handling (TRO-276 / ERR-10)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  let server: Server
  let handle: { stopSessionRevalidation?: () => void } | undefined
  let port: number
  let workspaceId: string
  let userId: string
  let sessionId: string

  const openSockets: WebSocket[] = []
  const openRawSockets: net.Socket[] = []
  const recorder = new ProcessCrashRecorder()

  beforeAll(async () => {
    const workspace = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`Malformed Frame Test ${testRunId}`]
    )
    workspaceId = workspace.rows[0].id

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Malformed Frame User') RETURNING id`,
      [`malformed-frame-${testRunId}@test.local`]
    )
    userId = user.rows[0].id

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [workspaceId, userId]
    )

    sessionId = crypto.randomBytes(32).toString('hex')
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())`,
      [sessionId, userId, workspaceId]
    )

    server = createServer()
    handle = collab.setupCollaboration(server, {
      sessionRevalidationIntervalMs: REVALIDATION_INTERVAL_MS,
    }) as { stopSessionRevalidation?: () => void } | undefined
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    recorder.stop()
    for (const ws of openSockets) {
      try { ws.terminate() } catch { /* already gone */ }
    }
    for (const socket of openRawSockets) {
      try { socket.destroy() } catch { /* already gone */ }
    }
    handle?.stopSessionRevalidation?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId])
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId])
    await pool.query('DELETE FROM users WHERE id = $1', [userId])
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
  })

  // Belt and braces: even if a case throws before its own stop(), vitest's
  // handlers are back in place before the next one runs.
  beforeEach(() => recorder.start())
  afterEach(() => recorder.stop())

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

  /** Read `documents.content` until it contains `marker`. Returns what it last saw. */
  function waitForContent(docId: string, marker: string): Promise<string> {
    return waitUntil(() => documentContent(docId), (content) => content.includes(marker))
  }

  /**
   * A write pushed through a live socket and observed arriving in the database.
   *
   * This is the file's liveness probe, and it is deliberately a full round trip:
   * it can only succeed if the server is still running, still reading that socket,
   * and still persisting. "The process survived" is otherwise an absence, and an
   * absence cannot be asserted by waiting.
   */
  async function expectWriteLands(client: TestClient, docId: string, marker: string, why: string): Promise<void> {
    client.type(marker)
    expect(await waitForContent(docId, marker), why).toContain(marker)
  }

  interface TestClient {
    ws: WebSocket
    doc: Y.Doc
    /** Type text into the local doc and push the resulting update at the server. */
    type: (text: string) => void
    /** Send raw bytes as a binary frame — the attacker's move. */
    sendRaw: (bytes: number[]) => void
    closeInfo: () => { closed: boolean; code: number | null }
    clientErrors: () => Error[]
  }

  async function connect(docId: string): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/collaboration/wiki:${docId}`, {
      headers: { cookie: `session_id=${sessionId}` },
    })
    openSockets.push(ws)

    let closed = false
    let code: number | null = null
    const clientErrors: Error[] = []
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

    // From here on a client-side socket error is data, not a test failure: the
    // server hanging up mid-frame is one of the outcomes under test. An
    // unhandled 'error' on a ws instance would otherwise throw.
    ws.on('error', (err: Error) => { clientErrors.push(err) })

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
          ws.send(encodeUpdateMessage(update))
        }
      },
      sendRaw: (bytes: number[]) => {
        ws.send(new Uint8Array(bytes))
      },
      closeInfo: () => ({ closed, code }),
      clientErrors: () => clientErrors,
    }
  }

  /**
   * Resolve on the socket's 'close' event — the event itself, not a poll.
   *
   * The deadline exists so a server that never closes yields a reportable
   * `{ closed: false }` instead of hanging the run: this file must go red with an
   * assertion when run against the unfixed module, and a timeout thrown from a
   * helper would be a broken test rather than a red one.
   *
   * Ordering note, which is why awaiting this is sufficient: the server sends the
   * close frame from inside `runFrameHandler`'s catch block, on the same I/O
   * callback that processed the frame. Observing the close therefore proves that
   * callback ran to completion — so any synchronous throw would already have
   * reached the recorder by the time this resolves.
   */
  function whenClosed(client: TestClient, timeoutMs = CLOSE_TIMEOUT_MS): Promise<{ closed: boolean; code: number | null }> {
    if (client.closeInfo().closed) return Promise.resolve(client.closeInfo())
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const onClose = () => {
        clearTimeout(timer)
        resolve(client.closeInfo())
      }
      timer = setTimeout(() => {
        client.ws.off('close', onClose)
        resolve(client.closeInfo())
      }, timeoutMs)
      client.ws.once('close', onClose)
    })
  }

  /** Same contract as whenClosed(), for a hand-driven raw TCP socket. */
  function whenRawClosed(socket: net.Socket, timeoutMs = CLOSE_TIMEOUT_MS): Promise<boolean> {
    if (socket.closed) return Promise.resolve(true)
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const onClose = () => {
        clearTimeout(timer)
        resolve(true)
      }
      timer = setTimeout(() => {
        socket.off('close', onClose)
        resolve(socket.closed)
      }, timeoutMs)
      socket.once('close', onClose)
    })
  }

  /**
   * Complete the WebSocket handshake by hand and hand back the raw TCP socket.
   *
   * The `ws` client cannot emit an invalid WebSocket *frame* — it only produces
   * well-formed ones — so proving the transport-level crash vector needs a socket
   * the test writes bytes to directly.
   */
  async function rawUpgrade(docId: string): Promise<net.Socket> {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    openRawSockets.push(socket)

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })

    socket.write(
      `GET /collaboration/wiki:${docId} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Cookie: session_id=${sessionId}\r\n\r\n`
    )

    await new Promise<void>((resolve, reject) => {
      let buffered = ''
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('latin1')
        if (!buffered.includes('\r\n\r\n')) return
        socket.off('data', onData)
        const [statusLine = ''] = buffered.split('\r\n')
        if (statusLine.startsWith('HTTP/1.1 101')) resolve()
        else reject(new Error(`upgrade rejected: ${statusLine || '<no status line>'}`))
      }
      socket.on('data', onData)
      socket.once('error', reject)
      setTimeout(() => reject(new Error('no upgrade response within 10s')), 10_000)
    })

    // From here a transport error on the CLIENT side is an expected outcome, not
    // a test failure — and an unhandled 'error' on a net.Socket would itself
    // reach the recorder and be misread as the server crashing.
    socket.on('error', () => { /* server hung up; that is the point */ })
    return socket
  }

  /**
   * A client-to-server WebSocket frame. `firstByte` carries FIN/RSV/opcode, so a
   * caller can set a reserved bit that the protocol forbids.
   */
  function maskedFrame(firstByte: number, payload: Buffer): Buffer {
    const mask = crypto.randomBytes(4)
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i++) {
      // readUInt8/writeUInt8 return and take plain numbers and range-check
      // themselves, so the masking loop needs no non-null assertions.
      masked.writeUInt8(masked.readUInt8(i) ^ mask.readUInt8(i % 4), i)
    }
    // Payloads here are tiny, so the 7-bit length form always applies.
    return Buffer.concat([Buffer.from([firstByte, 0x80 | masked.length]), mask, masked])
  }

  it('control: a well-formed update from an authorized socket persists', async () => {
    const docId = await createDocument('Malformed frame control doc')
    const client = await connect(docId)

    await expectWriteLands(
      client,
      docId,
      `WELLFORMED_${testRunId}`,
      'a well-formed update must still persist — otherwise the malformed-frame assertions below prove nothing'
    )
    expect(recorder.summary(), 'a well-formed update must not raise anything at the process level').toBe('none')

    client.ws.close()
  }, 40_000)

  it('exports the RFC 6455 protocol-error code this file asserts on', () => {
    // Pins the literal used throughout this file against the module's constant, so
    // the deliberate choice of 1002 (protocol error — the peer's bytes) over 1011
    // (internal error — our fault) cannot be changed without a test noticing.
    expect(collab.WS_CLOSE_PROTOCOL_ERROR).toBe(EXPECTED_CLOSE_CODE)
  })

  it.each(CRASHING_FRAMES)(
    'does not let a $label reach the process level',
    async ({ label, bytes, observedError }) => {
      const docId = await createDocument(`Malformed frame doc ${label}`)
      const client = await connect(docId)

      client.sendRaw(bytes)

      // Await the close event — the server emits it from the same I/O callback
      // that processed the frame, so this both orders the assertions after that
      // callback and is itself the behaviour under test. No settling delay.
      const info = await whenClosed(client)

      // The load-bearing assertion. Node kills a process on `uncaughtException`
      // precisely when nothing is listening, so an empty recorder is the proof
      // that this frame can no longer end the API for every other user.
      expect(
        recorder.summary(),
        `[${bytes.join(',')}] (${label}) escaped the frame handler — audit ERR-10 observed "${observedError}" here. ` +
          `In production nothing is listening, so this terminates the API for every connected user.`
      ).toBe('none')

      // Second half of the contract: the bad peer is hung up on. The Yjs
      // protocol has no mid-stream resync, so a client whose bytes we cannot
      // decode has nothing useful left to say.
      expect(
        info.closed,
        `the server must close the socket that sent [${bytes.join(',')}] (${label}) rather than leaving a peer it can no longer parse connected`
      ).toBe(true)
      expect(
        info.code,
        `[${bytes.join(',')}] (${label}) must be refused with ${EXPECTED_CLOSE_CODE} (protocol error — the peer's bytes), ` +
          `not 1011 (internal error — our fault) or a generic code`
      ).toBe(EXPECTED_CLOSE_CODE)
    },
    40_000
  )

  it.each(BENIGN_FRAMES)(
    'keeps serving a socket that sends a $label',
    async ({ label, bytes }) => {
      const docId = await createDocument(`Benign frame doc ${label}`)
      const client = await connect(docId)

      client.sendRaw(bytes)

      // The observable that replaces a settling delay, and a stronger claim than
      // "not closed": the same socket goes on to do real work. A write that
      // reaches the database can only have been read off a socket the server is
      // still serving, and it orders every assertion below after the benign frame
      // was processed.
      await expectWriteLands(
        client,
        docId,
        `TOLERATED_${testRunId}`,
        `[${bytes.join(',')}] (${label}) is tolerated by the protocol, so the socket must still be able to save afterwards`
      )

      expect(recorder.summary(), `[${bytes.join(',')}] (${label}) must not reach the process level`).toBe('none')
      expect(
        client.closeInfo().closed,
        `[${bytes.join(',')}] (${label}) is tolerated by the protocol — hanging up on it would be an over-broad fix that disconnects legitimate clients`
      ).toBe(false)

      client.ws.close()
    },
    40_000
  )

  it('does not let a frame that violates the WebSocket protocol itself reach the process level', async () => {
    const docId = await createDocument('Malformed frame RSV1 doc')
    const socket = await rawUpgrade(docId)

    // FIN=1, RSV1=1, opcode=2 (binary). RSV1 may only be set when
    // permessage-deflate has been negotiated, and it was not. `ws` rejects the
    // frame by emitting 'error' on the WebSocket — a *different* crash vector
    // from a malformed Yjs payload, because EventEmitter throws an 'error' event
    // that nobody listens for, and that throw is likewise uncatchable above the
    // I/O callback.
    socket.write(maskedFrame(0xc2, Buffer.from([0, 0])))

    const socketEnded = await whenRawClosed(socket)

    expect(
      recorder.summary(),
      'a WebSocket frame with a reserved bit set must not reach the process level — ws emits it as an ' +
        "'error' event, and an unhandled 'error' event is thrown by EventEmitter"
    ).toBe('none')
    expect(
      socketEnded,
      'the server must hang up on a peer that is not speaking WebSocket correctly'
    ).toBe(true)

    // The server is not merely un-crashed but still serving: a fresh client
    // completes a full write after the transport-level violation.
    const survivorDocId = await createDocument('Malformed frame post-RSV1 doc')
    const survivor = await connect(survivorDocId)
    await expectWriteLands(
      survivor,
      survivorDocId,
      `AFTER_RSV1_${testRunId}`,
      'the collaboration server must still accept and persist work after a protocol-violating frame — a dead process could not'
    )
    survivor.ws.close()
  }, 40_000)

  it('contains a rejected promise from an async frame handler instead of letting it escape', async () => {
    const docId = await createDocument('Malformed frame async handler doc')
    const client = await connect(docId)

    // `runFrameHandler`'s parameter is `() => void`, and TypeScript accepts an
    // async function there — a function returning Promise<void> is assignable to
    // `() => void`. So this compiles silently, and without the thenable branch in
    // runFrameHandler the rejection would land *after* its try/catch had exited
    // and resurface as an unhandled rejection: ERR-10 again, by the back door.
    // No cast is needed to express that, which is precisely the hazard.
    const asyncHandler: () => void = async () => {
      throw new Error('async frame handler rejected')
    }

    const runFrameHandler = collab.runFrameHandler
    expect(
      typeof runFrameHandler,
      'collaboration module must expose runFrameHandler so this branch can be pinned'
    ).toBe('function')

    runFrameHandler(client.ws, new Uint8Array([1, 2, 3]), { test: 'async-escape' }, asyncHandler)

    const info = await whenClosed(client)

    expect(
      recorder.summary(),
      'a rejected async frame handler must be routed through the guard, not surface as an unhandled rejection'
    ).toBe('none')
    expect(info.closed, 'the guard must close the socket for an async failure too').toBe(true)
    expect(info.code).toBe(EXPECTED_CLOSE_CODE)
  }, 40_000)

  it('keeps the co-tenant socket usable and stays connectable after every malformed frame', async () => {
    const docId = await createDocument('Malformed frame blast radius doc')
    const victim = await connect(docId)

    // A FRESH attacker per frame. Reusing one connection would mean every frame
    // after the first was written to a socket the server had already closed, so
    // the later iterations would assert nothing at all.
    for (const { label, bytes } of CRASHING_FRAMES) {
      const attacker = await connect(docId)
      attacker.sendRaw(bytes)

      const info = await whenClosed(attacker)
      expect(
        info.closed,
        `[${bytes.join(',')}] (${label}) must close its own socket during the burst — otherwise later frames in this loop test a dead socket`
      ).toBe(true)
      expect(info.code, `close code for [${bytes.join(',')}] during the burst`).toBe(EXPECTED_CLOSE_CODE)
      expect(
        victim.closeInfo().closed,
        `[${bytes.join(',')}] (${label}) must not disconnect another client on the same document`
      ).toBe(false)
    }

    expect(
      recorder.summary(),
      'a burst of malformed frames must not reach the process level'
    ).toBe('none')

    // Blast radius is one socket: the other editor on the same document is
    // untouched and can still write.
    await expectWriteLands(
      victim,
      docId,
      `COTENANT_${testRunId}`,
      'the co-tenant editor must still be able to save after another client sent garbage'
    )

    // And the server still accepts new work — a terminated process accepts none.
    const freshDocId = await createDocument('Malformed frame post-attack doc')
    const fresh = await connect(freshDocId)
    await expectWriteLands(
      fresh,
      freshDocId,
      `AFTER_ATTACK_${testRunId}`,
      'the collaboration server must still accept and persist new connections after malformed frames — a dead process could not'
    )

    victim.ws.close()
    fresh.ws.close()
  }, 60_000)
})
