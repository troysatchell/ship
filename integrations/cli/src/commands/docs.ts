/**
 * `ship docs ls | get <id> | create --title <title>` (PF-601, PLUGFORGE.MD
 * §4). AC, verbatim: "commands work against local + deployed Ship; non-zero
 * exit + stderr ApiError rendering on failure." All three subcommands go
 * through `@ship/sdk`'s `DocumentsClient` only (`client.documents.iterate/
 * get/create` — `sdk/src/resources/documents.ts`) — no bespoke HTTP handling
 * here, matching `login.ts`/`whoami.ts`'s own "thin command, real behavior
 * lives in the SDK" convention (`bin.ts`'s header).
 *
 * `ls` uses `iterate()`, not `list()` — PF-601's own brief: "use the SDK's
 * async-iterator iterate() so cursors stay internal, per the SDK's own
 * design" (`documents.ts`'s own doc comment on `iterate()`).
 *
 * Every subcommand needs a previously-stored token (`ship login` first, the
 * same precondition `whoami.ts` establishes for itself) — `loadClient()`
 * below is this file's own copy of that file's "read the store directly,
 * distinguish never-logged-in from a corrupt file, resolve clientId
 * best-effort for refresh-on-401, construct ShipClient" sequence. Not
 * imported from `whoami.ts`: that file exports no reusable function, and
 * this ticket's brief is explicit that `login.ts`/`whoami.ts` get no
 * drive-by edits, including turning their internals into a shared export.
 * Sharing this ONE seam across the three functions below (instead of
 * tripling it, one copy per subcommand) is a same-file, zero-footprint
 * dedupe — no new module, no change to either existing command file.
 */
import { ShipClient, type Document } from '@ship/sdk';
import { FileTokenStore } from '@ship/sdk/node';
import { resolveBaseUrl, resolveClientId, resolveCredentialsPath } from '../config.js';
import { formatError } from '../errors.js';
import type { Io } from '../io.js';

interface BaseDocsOptions {
  io: Io;
  env: NodeJS.ProcessEnv;
  clientId?: string;
  baseUrl?: string;
  credentialsPath?: string;
}

type LoadClientResult = { client: ShipClient } | { exitCode: number };

/**
 * Resolves config, loads a persisted token, and builds a `ShipClient` — or
 * returns the exit code a caller should return immediately, having already
 * rendered the failure via `io`. Mirrors `whoami.ts`'s own sequence
 * (including wrapping config resolution in try/catch from the start — that
 * file's own header notes a CodeRabbit-caught bug where an earlier version of
 * it did not, which is exactly the mistake this ticket's brief calls out to
 * avoid repeating here).
 */
async function loadClient(opts: BaseDocsOptions): Promise<LoadClientResult> {
  const { io } = opts;

  let credentialsPath: string;
  let baseUrl: string | undefined;
  try {
    credentialsPath = opts.credentialsPath ?? resolveCredentialsPath(opts.env);
    baseUrl = resolveBaseUrl(opts.baseUrl, opts.env);
  } catch (err) {
    io.stderr(formatError(err));
    return { exitCode: 1 };
  }
  const tokenStore = new FileTokenStore(credentialsPath);

  let tokens;
  try {
    tokens = await tokenStore.get();
  } catch (err) {
    // A corrupt/unreadable credentials file (FileTokenStore's own doc
    // comment: this is deliberately NOT the same as "no token yet").
    io.stderr(formatError(err));
    return { exitCode: 1 };
  }

  if (!tokens) {
    io.stderr(`Not logged in. Run \`ship login\` first (looked for credentials at ${credentialsPath}).`);
    return { exitCode: 1 };
  }

  // clientId is only required for refresh-on-401 to have somewhere to send
  // `POST /oauth/token` — resolved best-effort, same as whoami.ts, so a docs
  // command with an unexpired token still works even when SHIP_CLI_CLIENT_ID
  // isn't set.
  let clientId: string | undefined;
  try {
    clientId = resolveClientId(opts.clientId, opts.env);
  } catch {
    clientId = undefined;
  }

  return { client: new ShipClient({ baseUrl, token: tokens.accessToken, clientId, tokenStore }) };
}

/** One line per document, tab-separated (id, type, title) — scriptable,
 *  matching the plain-text convention of Unix list output rather than a
 *  human-padded table. */
function formatDocumentSummary(doc: Document): string {
  return `${doc.id}\t${doc.document_type}\t${doc.title}`;
}

/** Multi-line detail view for a single document (`get`/`create`). */
function formatDocumentDetail(doc: Document): string {
  return [
    `id: ${doc.id}`,
    `title: ${doc.title}`,
    `document_type: ${doc.document_type}`,
    `created_at: ${doc.created_at}`,
    `updated_at: ${doc.updated_at}`,
    `properties: ${JSON.stringify(doc.properties)}`,
  ].join('\n');
}

export type RunDocsLsOptions = BaseDocsOptions;

/** `ship docs ls`. Pages internally via `client.documents.iterate()` — the
 *  cursor never surfaces to the caller (PF-601's own AC). */
export async function runDocsLs(opts: RunDocsLsOptions): Promise<number> {
  const { io } = opts;
  const loaded = await loadClient(opts);
  if ('exitCode' in loaded) return loaded.exitCode;
  const { client } = loaded;

  try {
    let count = 0;
    for await (const doc of client.documents.iterate()) {
      io.stdout(formatDocumentSummary(doc));
      count += 1;
    }
    if (count === 0) {
      io.stdout('No documents found.');
    }
    return 0;
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }
}

export interface RunDocsGetOptions extends BaseDocsOptions {
  id: string;
}

/** `ship docs get <id>`. A malformed or non-existent id both surface as the
 *  server's `not_found` `ShipSdkError` (`documents.ts`'s own doc comment on
 *  `get()`) — rendered by `formatError` like any other SDK failure. */
export async function runDocsGet(opts: RunDocsGetOptions): Promise<number> {
  const { io } = opts;
  const loaded = await loadClient(opts);
  if ('exitCode' in loaded) return loaded.exitCode;
  const { client } = loaded;

  try {
    const doc = await client.documents.get(opts.id);
    io.stdout(formatDocumentDetail(doc));
    return 0;
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }
}

export interface RunDocsCreateOptions extends BaseDocsOptions {
  title?: string;
}

/** `ship docs create --title <title>`. `--title` is required at the public
 *  API surface with no "Untitled" default (`CreateDocumentRequestSchema`'s
 *  own doc comment, `resources/documents.ts`) — checked here, before any I/O,
 *  the same "fail fast on a local precondition, before ever calling fetch"
 *  shape `login.ts` already establishes for a missing client id (see that
 *  file's own `runLogin` and `login.test.ts`'s "fails fast ... before ever
 *  calling fetch" case). An empty string is treated the same as omitted,
 *  matching `config.ts`'s own `length > 0` convention for "was this really
 *  provided". */
export async function runDocsCreate(opts: RunDocsCreateOptions): Promise<number> {
  const { io } = opts;

  const title = opts.title;
  if (!title) {
    io.stderr('Error: --title is required.');
    return 1;
  }

  const loaded = await loadClient(opts);
  if ('exitCode' in loaded) return loaded.exitCode;
  const { client } = loaded;

  try {
    const doc = await client.documents.create({ title });
    io.stdout('Created document.');
    io.stdout(formatDocumentDetail(doc));
    return 0;
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }
}
