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

program.parseAsync(process.argv).catch((err: unknown) => {
  realIo.stderr(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
