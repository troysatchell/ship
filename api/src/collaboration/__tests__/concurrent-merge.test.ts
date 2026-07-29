import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import crypto from 'crypto'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import { pool } from '../../db/client.js'
import { setupCollaboration } from '../index.js'

/**
 * TRO-226 / TEST-4 — concurrent multi-client editing and Yjs merge.
 *
 * The CRDT is the whole justification for the Yjs architecture
 * (`docs/unified-document-model.md`): two people editing the same document at
 * the same time must both keep their edits, both converge on the same result,
 * and that result must survive in the database. Before this file nothing
 * verified any of that against the real server.
 *
 * What existed and why it was not enough:
 *   - `collaboration.test.ts` "should merge concurrent Yjs updates correctly"
 *     exchanges updates between two bare `Y.Doc`s with `Y.applyUpdate`. That
 *     tests the yjs library. No server, no socket, no persistence — a
 *     regression in `api/src/collaboration/index.ts` cannot fail it.
 *   - `session-revocation.test.ts` drives the real server over a real socket,
 *     but with one client and it never reads the server's frames back into a
 *     local doc, so it cannot observe a merge.
 *
 * This file speaks the real sync protocol in both directions against the real
 * `setupCollaboration()` over real WebSockets, and asserts on `documents`.
 *
 * SYNCHRONIZATION POLICY (TEST-11 / TRO-233: fixed sleeps are this repo's
 * dominant flake cause). There are no unconditional sleeps here. Convergence is
 * awaited on Yjs `update` events; persistence — which emits no event — is
 * awaited by re-reading the row until it satisfies a predicate, with a short
 * variable gap between reads. Every wait is a condition with a timeout, never a
 * duration chosen to be "probably long enough".
 */

// Wire protocol constants, mirroring api/src/collaboration/index.ts.
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

/**
 * `messageYjsSyncStep2` from y-protocols/sync (sync.js:39).
 *
 * Mirrored locally because tsc under this repo's NodeNext resolution does not
 * surface that package's exported *constants* — only its functions. Verified
 * with an isolated one-line probe: `sp.messageYjsSyncStep2` fails with TS2339
 * while `sp.readSyncMessage` resolves fine. `api/src/collaboration/index.ts`
 * hardcodes its own message-type constants for the same reason. These are wire
 * numbers; they cannot change without breaking every y-websocket client.
 */
const SYNC_STEP_2 = 1

/**
 * Transaction origin used when applying a frame that came from the server.
 * The client must not echo those updates back — it would loop, and it would
 * also make a lost update look delivered.
 */
const REMOTE_ORIGIN = { remote: true }

/** Gap between reads while waiting for a database predicate to hold. */
const DB_POLL_INTERVAL_MS = 50

/** Ceiling for any wait. Generous: the server debounces persistence by 2s. */
const CONVERGE_TIMEOUT_MS = 20_000
const PERSIST_TIMEOUT_MS = 30_000

function nextPoll(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, DB_POLL_INTERVAL_MS)
  })
}

function encodeUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

interface StoredDocument {
  /** `documents.content` — the JSON mirror the REST API reads. */
  content: string
  /**
   * `documents.yjs_state` decoded in this process into a fresh Y.Doc.
   * This is the assertion that matters for persistence: it proves the merged
   * CRDT state itself round-tripped through Postgres, not just its JSON shadow.
   */
  yjsText: string
  hasYjsState: boolean
}

async function readStored(docId: string): Promise<StoredDocument> {
  const result = await pool.query('SELECT content, yjs_state FROM documents WHERE id = $1', [docId])
  const row = result.rows[0]
  const content = row?.content == null ? '' : JSON.stringify(row.content)

  let yjsText = ''
  const hasYjsState = Boolean(row?.yjs_state)
  if (row?.yjs_state) {
    const decoded = new Y.Doc()
    Y.applyUpdate(decoded, new Uint8Array(row.yjs_state))
    yjsText = decoded.getXmlFragment('default').toString()
  }

  return { content, yjsText, hasYjsState }
}

async function waitForStored(
  docId: string,
  predicate: (stored: StoredDocument) => boolean,
  label: string,
  timeoutMs = PERSIST_TIMEOUT_MS
): Promise<StoredDocument> {
  const deadline = Date.now() + timeoutMs
  let reads = 0
  let stored = await readStored(docId)
  reads++

  while (!predicate(stored)) {
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: database predicate never held within ${timeoutMs}ms (${reads} reads). ` +
          `last content=${stored.content.slice(0, 300)} last yjs_state=${stored.yjsText.slice(0, 300)}`
      )
    }
    await nextPoll()
    stored = await readStored(docId)
    reads++
  }

  return stored
}

/** A Yjs collaboration client: its own Y.Doc, its own socket, real sync protocol. */
interface Client {
  name: string
  doc: Y.Doc
  socket: () => WebSocket
  /** Structure + text of the local replica, used for convergence comparison. */
  snapshot: () => string
  /** Resolves once the server's sync step 2 has been applied locally. */
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  /** Await a local-replica condition, driven by Yjs update events (no sleeping). */
  waitForDoc: (predicate: () => boolean, label: string, timeoutMs?: number) => Promise<void>
  appendParagraph: (text: string) => void
}

describe('Concurrent multi-client editing / Yjs merge (TRO-226 / TEST-4)', () => {
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  let server: Server
  let handle: { stopSessionRevalidation: () => void } | undefined
  let port: number
  let workspaceId: string
  // Two distinct users, because two collaborators is the point. Named rather
  // than indexed out of an array: `noUncheckedIndexedAccess` is on, and the
  // alternative is a non-null assertion, which the factory's pattern gate
  // rejects for good reason.
  let userAId: string
  let userBId: string

  const openSockets: WebSocket[] = []

  async function createUser(label: string): Promise<string> {
    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', $2) RETURNING id`,
      [`merge-${label}-${testRunId}@test.local`, `Merge User ${label.toUpperCase()}`]
    )
    const userId: string = user.rows[0].id
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [workspaceId, userId]
    )
    return userId
  }

  beforeAll(async () => {
    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `Merge Test ${testRunId}`,
    ])
    workspaceId = workspace.rows[0].id

    userAId = await createUser('a')
    userBId = await createUser('b')

    server = createServer()
    // A long revalidation interval: this file is about merge, not revocation.
    // A short sweep would only add queries and a way to fail for the wrong reason.
    handle = setupCollaboration(server, { sessionRevalidationIntervalMs: 60_000 })
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
    handle?.stopSessionRevalidation()
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

  /**
   * Seed a document through `documents.content`, the shape the REST API creates.
   * The collaboration server converts it to Yjs on first connection, so both
   * clients receive the same starting text and can then edit the same region.
   */
  async function createDocument(title: string, seedText?: string): Promise<string> {
    const content = seedText
      ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: seedText }] }] }
      : { type: 'doc', content: [{ type: 'paragraph' }] }

    const result = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, visibility, created_by)
       VALUES ($1, 'wiki', $2, $3, 'workspace', $4) RETURNING id`,
      [workspaceId, title, JSON.stringify(content), userAId]
    )
    return result.rows[0].id
  }

  function makeClient(name: string, docId: string, sessionId: string): Client {
    const doc = new Y.Doc()
    let ws: WebSocket | null = null
    const framesSeen: number[] = []
    const closeEvents: string[] = []
    let requestedServerState = false

    // Local edits go to the server; frames that came FROM the server do not.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return
      const current = ws
      if (!current || current.readyState !== WebSocket.OPEN) return
      try {
        current.send(encodeUpdateMessage(update))
      } catch {
        // Socket went away mid-send. The update stays in the local doc and is
        // carried by the step1/step2 exchange on the next connection — which is
        // exactly the offline case one of the tests below exercises.
      }
    })

    function handleFrame(data: Buffer, onSynced: () => void): void {
      const decoder = decoding.createDecoder(new Uint8Array(data))
      const messageType = decoding.readVarUint(decoder)
      framesSeen.push(messageType)

      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        const syncType = syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE_ORIGIN)
        if (encoding.length(encoder) > 1) {
          const current = ws
          if (current && current.readyState === WebSocket.OPEN) {
            current.send(encoding.toUint8Array(encoder))
          }
        }
        // Ask for the server's state only once we have proof the server is
        // listening, i.e. after its first frame.
        //
        // WHY NOT ON 'open' (this cost an hour, and it is a real property of the
        // server): `wss.on('connection')` in api/src/collaboration/index.ts
        // `await`s getOrCreateDoc() — a database round trip — and registers
        // `ws.on('message')` only afterwards. A frame that arrives during that
        // window has no listener and is dropped by the EventEmitter, so the
        // server never answers the client's sync step 1 and the client never
        // learns the server's state. Observed here on loopback, where the
        // client's step 1 beats the DB read: frames received were [3,0,1,1] —
        // cache-clear, the server's own step 1, two awareness updates, and no
        // step 2, forever. The server sends its step 1 in the same synchronous
        // block that attaches the listener, so replying to that frame is
        // race-free. Reported separately; not this ticket's fix.
        if (!requestedServerState) {
          requestedServerState = true
          const current = ws
          if (current && current.readyState === WebSocket.OPEN) {
            current.send(encodeSyncStep1(doc))
          }
        }

        // Step 2 carries the server's state; once applied, this replica has
        // everything the server had at handshake time.
        if (syncType === SYNC_STEP_2) onSynced()
        return
      }

      // MESSAGE_AWARENESS and the cache-clear signal (type 3) are irrelevant to
      // merge behaviour and are deliberately ignored rather than mishandled.
      if (messageType === MESSAGE_AWARENESS) return
    }

    async function connect(): Promise<void> {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/collaboration/wiki:${docId}`, {
        headers: { cookie: `session_id=${sessionId}` },
      })
      ws = socket
      openSockets.push(socket)

      // Kept for failure messages: "no sync step 2 arrived" is much easier to
      // act on when the report says which frames DID arrive, or that the socket
      // was closed with code 4401 instead.
      framesSeen.length = 0
      closeEvents.length = 0
      requestedServerState = false

      let markSynced: (() => void) | null = null
      let clearHandshakeTimer: (() => void) | null = null
      const synced = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `${name}: server never completed the sync handshake — ` +
                `frames received: [${framesSeen.join(',')}], close events: [${closeEvents.join(',')}]`
            )
          )
        }, CONVERGE_TIMEOUT_MS)
        timer.unref?.()
        clearHandshakeTimer = () => clearTimeout(timer)
        markSynced = resolve
      })

      socket.on('message', (data: Buffer) => {
        handleFrame(data, () => {
          clearHandshakeTimer?.()
          markSynced?.()
        })
      })
      socket.on('close', (code: number, reason: Buffer) => {
        closeEvents.push(`${code}:${reason.toString().slice(0, 40)}`)
      })

      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve())
        socket.on('error', reject)
      })

      // The step 1 we owe the server is sent from handleFrame, once the server
      // has proved it is listening. See the comment there.
      await synced
    }

    async function disconnect(): Promise<void> {
      const current = ws
      if (!current) return
      if (current.readyState === WebSocket.CLOSED) {
        ws = null
        return
      }
      const closed = new Promise<void>((resolve) => current.once('close', () => resolve()))
      current.close()
      await closed
      ws = null
    }

    function waitForDoc(
      predicate: () => boolean,
      label: string,
      timeoutMs = CONVERGE_TIMEOUT_MS
    ): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (predicate()) {
          resolve()
          return
        }
        const onUpdate = () => {
          if (!predicate()) return
          cleanup()
          resolve()
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(
            new Error(
              `${name}: ${label} — condition never held within ${timeoutMs}ms. ` +
                `local replica: ${doc.getXmlFragment('default').toString().slice(0, 300)} ` +
                `frames received: [${framesSeen.join(',')}], close events: [${closeEvents.join(',')}]`
            )
          )
        }, timeoutMs)
        const cleanup = () => {
          clearTimeout(timer)
          doc.off('update', onUpdate)
        }
        doc.on('update', onUpdate)
      })
    }

    return {
      name,
      doc,
      socket: () => {
        const current = ws
        if (!current) throw new Error(`${name}: not connected`)
        return current
      },
      snapshot: () => doc.getXmlFragment('default').toString(),
      connect,
      disconnect,
      waitForDoc,
      appendParagraph: (text: string) => {
        doc.transact(() => {
          const paragraph = new Y.XmlElement('paragraph')
          doc.getXmlFragment('default').push([paragraph])
          const node = new Y.XmlText()
          paragraph.push([node])
          node.insert(0, text)
        })
      },
    }
  }

  /** The Y.XmlText inside the first paragraph — the shared "same region". */
  function firstParagraphText(client: Client): Y.XmlText {
    const fragment = client.doc.getXmlFragment('default')
    const first = fragment.get(0)
    if (!(first instanceof Y.XmlElement)) {
      throw new Error(
        `${client.name}: expected a paragraph element at index 0, got ${String(first)} ` +
          `(replica: ${fragment.toString().slice(0, 200)})`
      )
    }
    const inner = first.get(0)
    if (!(inner instanceof Y.XmlText)) {
      throw new Error(
        `${client.name}: expected an XmlText inside the first paragraph, got ${String(inner)} ` +
          `(replica: ${fragment.toString().slice(0, 200)})`
      )
    }
    return inner
  }

  it('persists a single client edit through the real server (control)', async () => {
    const docId = await createDocument('Merge control doc')
    const client = makeClient('control', docId, await createSession(userAId))
    await client.connect()

    const marker = `CONTROL_${testRunId}`
    client.appendParagraph(marker)

    const stored = await waitForStored(
      docId,
      (s) => s.content.includes(marker),
      'control edit did not persist'
    )
    expect(
      stored.yjsText,
      'if a single authorized client cannot get an edit into yjs_state, every merge assertion below would fail for an unrelated reason'
    ).toContain(marker)

    await client.disconnect()
  }, 60_000)

  it('merges concurrent edits from two clients in different regions without losing either', async () => {
    const docId = await createDocument('Merge distinct regions doc')
    const clientA = makeClient('clientA', docId, await createSession(userAId))
    const clientB = makeClient('clientB', docId, await createSession(userBId))
    await clientA.connect()
    await clientB.connect()

    const markerA = `ALICE_${testRunId}`
    const markerB = `BOB_${testRunId}`

    // CONCURRENT, not sequential. Both edits are made in one synchronous block:
    // Node cannot deliver either socket's 'message' event in the middle of it, so
    // neither update is in the other's causal history. That is the definition of
    // concurrent for a CRDT, and it is asserted rather than assumed just below.
    clientA.appendParagraph(markerA)
    clientB.appendParagraph(markerB)

    expect(
      clientA.snapshot(),
      "clientA must not have seen clientB's edit yet — otherwise these edits were sequential and the merge path is not under test"
    ).not.toContain(markerB)
    expect(
      clientB.snapshot(),
      "clientB must not have seen clientA's edit yet — otherwise these edits were sequential and the merge path is not under test"
    ).not.toContain(markerA)

    await clientA.waitForDoc(
      () => clientA.snapshot().includes(markerB),
      `clientA never received clientB's concurrent edit (${markerB})`
    )
    await clientB.waitForDoc(
      () => clientB.snapshot().includes(markerA),
      `clientB never received clientA's concurrent edit (${markerA})`
    )

    // Convergence: the CRDT guarantee. Same document, byte-identical replicas.
    expect(
      clientA.snapshot(),
      'the two replicas must converge on the same document after exchanging concurrent updates'
    ).toBe(clientB.snapshot())
    expect(clientA.snapshot()).toContain(markerA)
    expect(clientA.snapshot()).toContain(markerB)

    // Persistence: the merged state must be in the database, not just in memory.
    const stored = await waitForStored(
      docId,
      (s) => s.content.includes(markerA) && s.content.includes(markerB),
      'merged content never reached documents.content'
    )
    expect(stored.hasYjsState, 'yjs_state must be written, not left NULL').toBe(true)
    expect(
      stored.yjsText,
      "clientA's edit must survive in yjs_state — a merge that only lives in memory is lost on restart"
    ).toContain(markerA)
    expect(
      stored.yjsText,
      "clientB's edit must survive in yjs_state — a merge that only lives in memory is lost on restart"
    ).toContain(markerB)

    await clientA.disconnect()
    await clientB.disconnect()
  }, 90_000)

  it('merges concurrent inserts from two clients into the SAME text region', async () => {
    // The seeded paragraph is the contested region. Both clients insert at the
    // same offset in the same Y.XmlText — where a CRDT either works or does not.
    const seed = `SEED-${testRunId}-TAIL`
    const insertAt = `SEED-${testRunId}-`.length
    const docId = await createDocument('Merge same region doc', seed)

    const clientA = makeClient('clientA', docId, await createSession(userAId))
    const clientB = makeClient('clientB', docId, await createSession(userBId))
    await clientA.connect()
    await clientB.connect()

    // Both replicas must actually hold the seed before the contested inserts,
    // or "same region" is a claim about two different regions.
    await clientA.waitForDoc(() => clientA.snapshot().includes(seed), 'clientA never received the seed text')
    await clientB.waitForDoc(() => clientB.snapshot().includes(seed), 'clientB never received the seed text')

    const markerA = `<A>`
    const markerB = `<B>`
    const textA = firstParagraphText(clientA)
    const textB = firstParagraphText(clientB)
    expect(textA.toString(), 'both clients must start from the same text').toBe(textB.toString())

    // Concurrent inserts at the same index in the same shared text.
    clientA.doc.transact(() => textA.insert(insertAt, markerA))
    clientB.doc.transact(() => textB.insert(insertAt, markerB))

    expect(
      textA.toString(),
      "clientA must not yet contain clientB's insert — otherwise the inserts were sequential"
    ).not.toContain(markerB)
    expect(
      textB.toString(),
      "clientB must not yet contain clientA's insert — otherwise the inserts were sequential"
    ).not.toContain(markerA)

    await clientA.waitForDoc(
      () => textA.toString().includes(markerB),
      `clientA never received clientB's same-region insert`
    )
    await clientB.waitForDoc(
      () => textB.toString().includes(markerA),
      `clientB never received clientA's same-region insert`
    )

    const mergedA = textA.toString()
    const mergedB = textB.toString()

    // Yjs breaks the tie by client id, so which marker lands first is not stable
    // across runs and is deliberately not asserted. What must hold is: both
    // inserts survive, the replicas agree, and the original text is intact.
    expect(
      mergedA,
      'two clients inserting at the same offset must converge on one identical string'
    ).toBe(mergedB)
    expect(mergedA, "clientA's insert was dropped from the contested region").toContain(markerA)
    expect(mergedA, "clientB's insert was dropped from the contested region").toContain(markerB)
    expect(
      mergedA.replace(markerA, '').replace(markerB, ''),
      'the pre-existing text must survive both concurrent inserts unmangled'
    ).toBe(seed)

    const stored = await waitForStored(
      docId,
      (s) => s.content.includes(markerA) && s.content.includes(markerB),
      'same-region merge never reached documents.content'
    )
    expect(stored.yjsText, 'the merged contested region must survive in yjs_state').toContain(markerA)
    expect(stored.yjsText, 'the merged contested region must survive in yjs_state').toContain(markerB)
    // The persisted copy is the merged one, not one client's view of it.
    expect(
      stored.yjsText.includes(seed) || stored.yjsText.includes(seed.slice(0, insertAt)),
      `persisted state lost the seeded text: ${stored.yjsText.slice(0, 300)}`
    ).toBe(true)

    await clientA.disconnect()
    await clientB.disconnect()
  }, 90_000)

  it('merges an edit made while one client was disconnected with the edit the other made online', async () => {
    // The regression this guards against is the expensive one: a client edits,
    // its socket is gone, and on reconnect its work is silently discarded in
    // favour of whatever the server has.
    const seed = `OFFLINE-SEED-${testRunId}`
    const docId = await createDocument('Merge offline doc', seed)

    const clientA = makeClient('clientA', docId, await createSession(userAId))
    const clientB = makeClient('clientB', docId, await createSession(userBId))
    await clientA.connect()
    await clientB.connect()
    await clientA.waitForDoc(() => clientA.snapshot().includes(seed), 'clientA never received the seed text')
    await clientB.waitForDoc(() => clientB.snapshot().includes(seed), 'clientB never received the seed text')

    const offlineMarker = `OFFLINE_EDIT_${testRunId}`
    const onlineMarker = `ONLINE_EDIT_${testRunId}`

    await clientA.disconnect()

    // A edits with no socket; B edits with one. Divergent by construction.
    clientA.appendParagraph(offlineMarker)
    clientB.appendParagraph(onlineMarker)

    const storedWhileOffline = await waitForStored(
      docId,
      (s) => s.content.includes(onlineMarker),
      "the online client's edit never persisted"
    )
    expect(
      storedWhileOffline.content,
      "the disconnected client's edit must not appear in the database before it reconnects — if it does, this test is not exercising divergence"
    ).not.toContain(offlineMarker)

    await clientA.connect()

    await clientA.waitForDoc(
      () => clientA.snapshot().includes(onlineMarker),
      "reconnected clientA never received the edit made online while it was away"
    )
    await clientB.waitForDoc(
      () => clientB.snapshot().includes(offlineMarker),
      "clientB never received the edit clientA made while disconnected"
    )

    expect(
      clientA.snapshot(),
      'the reconnected replica and the online replica must converge'
    ).toBe(clientB.snapshot())

    const stored = await waitForStored(
      docId,
      (s) => s.content.includes(offlineMarker) && s.content.includes(onlineMarker),
      'the reconnect merge never reached documents.content'
    )
    expect(
      stored.yjsText,
      'an edit made while disconnected must be merged and persisted on reconnect, not discarded'
    ).toContain(offlineMarker)
    expect(stored.yjsText, "the online client's edit must not be clobbered by the reconnect").toContain(
      onlineMarker
    )
    expect(stored.yjsText, 'the seeded text must survive the reconnect merge').toContain(seed)

    await clientA.disconnect()
    await clientB.disconnect()
  }, 90_000)
})
