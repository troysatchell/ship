// @ship/sdk — public barrel. PF-400 (PLUGFORGE.MD §2.8): scaffold + core
// client. PF-401 adds the documents/issues/sprints/webhooks resource
// clients below (webhooks is type-shape-only — its server routes don't
// exist yet, see resources/webhooks.ts's header). PF-404 adds the auth
// helpers: `ITokenStore` + `MemoryTokenStore`/`FileTokenStore`,
// `generatePkcePair`, and `ShipClient.deviceLogin`/
// `ShipClient.authorizationCodeFlow` (the static methods themselves are
// exported via the `ShipClient` class, not separately). `iterate()`
// (PF-402) remains a later ticket and is not exported here yet.

export { ShipClient } from './client.js';
export type { ShipClientOptions } from './client.js';

export type {
  Me,
  MeUser,
  MeApp,
  ListPage,
  DocumentType,
  Document,
  DocumentList,
  ListDocumentsParams,
  CreateDocumentBody,
  IssueState,
  IssuePriority,
  Issue,
  IssueList,
  ListIssuesParams,
  Sprint,
  SprintList,
  ListSprintsParams,
} from './types.js';

export { DocumentsClient } from './resources/documents.js';
export { IssuesClient } from './resources/issues.js';
export { SprintsClient } from './resources/sprints.js';
export { WebhooksClient } from './resources/webhooks.js';
export type {
  WebhookEventType,
  WebhookSubscription,
  CreatedWebhookSubscription,
  CreateWebhookSubscriptionBody,
  ListWebhookSubscriptionsParams,
  WebhookSubscriptionList,
  WebhookDelivery,
  ListWebhookDeliveriesParams,
  WebhookDeliveryList,
} from './resources/webhooks.js';

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
