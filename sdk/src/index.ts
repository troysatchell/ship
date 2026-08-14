// @ship/sdk — public barrel. PF-400 (PLUGFORGE.MD §2.8): scaffold + core
// client. Resource clients (documents/issues/sprints/webhooks — PF-401) and
// auth helpers (tokenStore, authorizationCodeFlow, deviceLogin — PF-404) are
// later tickets and are not exported here yet.

export { ShipClient } from './client.js';
export type { ShipClientOptions } from './client.js';

export type { Me, MeUser, MeApp } from './types.js';

export {
  ShipSdkError,
  mapApiErrorCodeToKind,
} from './errors.js';
export type { ApiErrorCode, ApiErrorBody, SdkErrorKind, SdkErrorShape } from './errors.js';

export {
  verifyWebhook,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  SHIP_SIGNATURE_HEADER_NAME,
} from './verifyWebhook.js';
