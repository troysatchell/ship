/**
 * Renders any error this CLI can throw into a single human-readable line for
 * `Io.stderr` — the one place formatting decisions about failure output
 * live, so `commands/login.ts`/`commands/whoami.ts` never inline their own
 * `String(err)`/`err.message` guesswork (this repo's own claim-provenance
 * rule: an unmarked `any`-shaped catch is exactly how a real error gets
 * mis-rendered).
 */
import { ShipSdkError } from '@ship/sdk';
import { CliConfigError } from './config.js';

export function formatError(err: unknown): string {
  if (err instanceof CliConfigError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof ShipSdkError) {
    const status = err.httpStatus !== undefined ? ` (HTTP ${err.httpStatus})` : '';
    return `Error [${err.kind}]: ${err.message}${status}`;
  }
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return `Error: ${String(err)}`;
}
