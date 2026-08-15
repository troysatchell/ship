// @ship/sdk/node — Node-only exports (TRO-449/PF-802), a separate entry
// point from the main `@ship/sdk` barrel (`index.ts`) specifically so a
// browser bundler resolving the main barrel never has to bind these two
// modules' Node built-in imports (`node:crypto`, `fs`, `path`). See
// `index.ts`'s own header and this repo's `CHANGES.md` (TRO-449) for the
// full investigation of why that split is required, not cosmetic.
//
// PF-403's webhook signature verifier (`verifyWebhook`) and PF-404's
// filesystem-backed `ITokenStore` implementation (`FileTokenStore`,
// PF-600's `ship login` / `~/.ship/credentials.json`) both only ever run in
// a Node process — neither has (or needs) a browser equivalent.

export {
  verifyWebhook,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  SHIP_SIGNATURE_HEADER_NAME,
} from './verifyWebhook.js';
export type { PlainHeaders } from './verifyWebhook.js';

export { FileTokenStore } from './fileTokenStore.js';
