// @ship/sdk — public barrel. PF-400 (PLUGFORGE.MD §2.8): scaffold + core
// client. PF-404 (this ticket) adds the auth helpers: `ITokenStore` +
// `MemoryTokenStore`/`FileTokenStore`, `generatePkcePair`, and
// `ShipClient.deviceLogin`/`ShipClient.authorizationCodeFlow` (the static
// methods themselves are exported via the `ShipClient` class, not
// separately). Resource clients (documents/issues/sprints/webhooks — PF-401)
// are still a later ticket.

export { ShipClient } from './client.js';
export type { ShipClientOptions } from './client.js';

export type { Me, MeUser, MeApp } from './types.js';

export {
  ShipSdkError,
  mapApiErrorCodeToKind,
} from './errors.js';
export type { ApiErrorCode, ApiErrorBody, SdkErrorKind, SdkErrorShape } from './errors.js';

export { MemoryTokenStore, FileTokenStore } from './tokenStore.js';
export type { ITokenStore, TokenSet } from './tokenStore.js';

export { generatePkcePair } from './pkce.js';
export type { PkcePair } from './pkce.js';

export type { DeviceLoginFlowOptions } from './deviceLogin.js';

export type {
  AuthorizationCodeFlowOptions,
  AuthorizationCodeFlowResult,
  PkceLocation,
  PkceStorage,
} from './authorizationCodeFlow.js';
