#!/usr/bin/env node
/**
 * `ship` — the PF-600 CLI entry point. Deliberately thin: argument parsing
 * (commander — the one CLI-plumbing devDependency PLUGFORGE.MD §2.1 names
 * explicitly as allowed alongside `@ship/sdk`) and wiring `process.exitCode`
 * to whatever `runLogin`/`runWhoami` (`commands/*.ts`) return. All real
 * behavior lives in those two functions and in `@ship/sdk` underneath them,
 * so this file has nothing worth unit-testing on its own — `commands/*.test.ts`
 * and the live-server integration test cover the actual logic.
 */
import { Command } from 'commander';
import { runLogin } from './commands/login.js';
import { runWhoami } from './commands/whoami.js';
import { runDocsCreate, runDocsGet, runDocsLs } from './commands/docs.js';
import { runWebhooksTail } from './commands/webhooksTail.js';
import { realIo } from './io.js';

const program = new Command();

program.name('ship').description('Ship platform CLI').version('0.0.0');

program
  .command('login')
  .description('Authorize this CLI via the OAuth device flow and store credentials at ~/.ship/credentials.json')
  .option('--client-id <id>', `OAuth client_id (overrides ${'SHIP_CLI_CLIENT_ID'})`)
  .option('--base-url <url>', 'Ship API base URL (overrides SHIP_API_BASE_URL)')
  .option('--scope <scope>', 'space-delimited OAuth scopes to request')
  .action(async (options: { clientId?: string; baseUrl?: string; scope?: string }) => {
    process.exitCode = await runLogin({
      io: realIo,
      env: process.env,
      clientId: options.clientId,
      baseUrl: options.baseUrl,
      scope: options.scope,
    });
  });

program
  .command('whoami')
  .description('Show the identity and scopes of the currently stored credentials')
  .option('--client-id <id>', `OAuth client_id, used only for refresh-on-401 (overrides ${'SHIP_CLI_CLIENT_ID'})`)
  .option('--base-url <url>', 'Ship API base URL (overrides SHIP_API_BASE_URL)')
  .action(async (options: { clientId?: string; baseUrl?: string }) => {
    process.exitCode = await runWhoami({
      io: realIo,
      env: process.env,
      clientId: options.clientId,
      baseUrl: options.baseUrl,
    });
  });

// PF-601 — `ship docs ls | get <id> | create --title <title>`, via
// `@ship/sdk`'s `DocumentsClient` only (`commands/docs.ts`'s own header).
// Nested subcommand group, same commander feature `bin.ts`'s own comment
// above already relies on (`program.command(...)`) — `docsCommand.command(...)`
// registers each leaf under `ship docs <leaf>`.
const docsCommand = program.command('docs').description('Work with documents via the public API');

docsCommand
  .command('ls')
  .description('List documents')
  .option('--client-id <id>', `OAuth client_id, used only for refresh-on-401 (overrides ${'SHIP_CLI_CLIENT_ID'})`)
  .option('--base-url <url>', 'Ship API base URL (overrides SHIP_API_BASE_URL)')
  .action(async (options: { clientId?: string; baseUrl?: string }) => {
    process.exitCode = await runDocsLs({
      io: realIo,
      env: process.env,
      clientId: options.clientId,
      baseUrl: options.baseUrl,
    });
  });

docsCommand
  .command('get')
  .argument('<id>', 'document id')
  .description('Get a document by id')
  .option('--client-id <id>', `OAuth client_id, used only for refresh-on-401 (overrides ${'SHIP_CLI_CLIENT_ID'})`)
  .option('--base-url <url>', 'Ship API base URL (overrides SHIP_API_BASE_URL)')
  .action(async (id: string, options: { clientId?: string; baseUrl?: string }) => {
    process.exitCode = await runDocsGet({
      io: realIo,
      env: process.env,
      clientId: options.clientId,
      baseUrl: options.baseUrl,
      id,
    });
  });

docsCommand
  .command('create')
  .description('Create a document')
  .option('--title <title>', 'document title (required)')
  .option('--client-id <id>', `OAuth client_id, used only for refresh-on-401 (overrides ${'SHIP_CLI_CLIENT_ID'})`)
  .option('--base-url <url>', 'Ship API base URL (overrides SHIP_API_BASE_URL)')
  .action(async (options: { title?: string; clientId?: string; baseUrl?: string }) => {
    process.exitCode = await runDocsCreate({
      io: realIo,
      env: process.env,
      clientId: options.clientId,
      baseUrl: options.baseUrl,
      title: options.title,
    });
  });

// PF-602 (Linear TRO-452) — `ship webhooks tail`: local listener, live
// signature check, subscription cleanup on exit. See `commands/
// webhooksTail.ts`'s own header for the full design (why one subscription,
// why the secret is set after listen(), the --target-url tunnel path for a
// remote instance).
const webhooksCommand = program.command('webhooks').description('Work with webhook subscriptions via the public API');

webhooksCommand
  .command('tail')
  .description(
    'Start a local listener, register a webhook subscription targeting it, and stream deliveries to stdout ' +
      'with a live signature check (verified/rejected) until Ctrl+C, then deactivate the subscription. Works ' +
      'against a local or containerized Ship instance (the server must be able to reach this listener over ' +
      '127.0.0.1). For a remote/deployed instance, start a tunnel (e.g. `ngrok http <port>`) forwarding to ' +
      'this listener\'s local port, then pass --target-url <tunnel-https-url> and the same --port.'
  )
  .option(
    '--app-id <id>',
    "OAuth app_id to own the subscription (defaults to the current token's own app, i.e. what `ship whoami` reports)"
  )
  .option('--event-type <type>', 'webhook event type to subscribe to (default: document.created)')
  .option('--port <port>', 'local port to listen on (default: an OS-assigned free port)')
  .option(
    '--target-url <url>',
    'override the registered target_url (default: http://127.0.0.1:<port>/) — set to a tunnel URL for a remote instance'
  )
  .option('--client-id <id>', `OAuth client_id, used only for refresh-on-401 (overrides ${'SHIP_CLI_CLIENT_ID'})`)
  .option('--base-url <url>', 'Ship API base URL (overrides SHIP_API_BASE_URL)')
  .action(
    async (options: {
      appId?: string;
      eventType?: string;
      port?: string;
      targetUrl?: string;
      clientId?: string;
      baseUrl?: string;
    }) => {
      process.exitCode = await runWebhooksTail({
        io: realIo,
        env: process.env,
        clientId: options.clientId,
        baseUrl: options.baseUrl,
        appId: options.appId,
        eventType: options.eventType,
        port: options.port !== undefined ? Number(options.port) : undefined,
        targetUrl: options.targetUrl,
      });
    }
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  realIo.stderr(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
