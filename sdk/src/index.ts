// @ship/sdk — public barrel. PF-400 (PLUGFORGE.MD §2.8): scaffold + core
// client. PF-401 adds the documents/issues/sprints/webhooks resource
// clients below (webhooks is type-shape-only — its server routes don't
// exist yet, see resources/webhooks.ts's header). PF-403 adds the one-call
// webhook signature verifier: `verifyWebhook` +
// `DEFAULT_WEBHOOK_TOLERANCE_SECONDS`/`SHIP_SIGNATURE_HEADER_NAME`/
// `PlainHeaders` (unrelated to PF-401's `WebhooksClient` resource client
// above — that manages subscriptions/deliveries over HTTP; this verifies an
// inbound delivery's signature locally, no network call). PF-404 adds the
// auth helpers: `ITokenStore` + `MemoryTokenStore`/`FileTokenStore`,
// `generatePkcePair`, and `ShipClient.deviceLogin`/
// `ShipClient.authorizationCodeFlow` (the static methods themselves are
// exported via the `ShipClient` class, not separately). PF-402 adds
// `iterate()` on `documents`/`issues`/`sprints` (methods on the already-
// exported resource-client classes, so no new class export) plus the three
// `Iterate*Params` types below. PF-205 adds `PeopleClient`/`ChangesClient`
// (new resource-client exports, unlike PF-402's methods-only additions) plus
// four new methods on the existing `DocumentsClient`/`SprintsClient`
// exports (`getAssociations`/`getReverseAssociations`/`getBacklinks`/
// `getComments`, `get`) and every wire type those seven methods need.

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
  IterateDocumentsParams,
  CreateDocumentBody,
  IssueState,
  IssuePriority,
  Issue,
  IssueList,
  ListIssuesParams,
  IterateIssuesParams,
  Sprint,
  SprintList,
  ListSprintsParams,
  IterateSprintsParams,
  // PF-205 (Linear TRO-414) additions.
  SprintDetail,
  AssociationEdge,
  AssociationEdgeList,
  ListAssociationsParams,
  Backlink,
  BacklinkList,
  ListBacklinksParams,
  DocumentComment,
  DocumentCommentList,
  ListDocumentCommentsParams,
  Person,
  PersonList,
  ListPeopleParams,
  IteratePeopleParams,
  ChangeEntry,
  ChangedDocumentEntry,
  ChangedHistoryEntry,
  ChangedCommentEntry,
  ChangesPage,
  GetChangesParams,
} from './types.js';

export { DocumentsClient } from './resources/documents.js';
export { IssuesClient } from './resources/issues.js';
export { SprintsClient } from './resources/sprints.js';
export { WebhooksClient } from './resources/webhooks.js';
// PF-205 (Linear TRO-414) additions.
export { PeopleClient } from './resources/people.js';
export { ChangesClient } from './resources/changes.js';
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

export {
  verifyWebhook,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  SHIP_SIGNATURE_HEADER_NAME,
} from './verifyWebhook.js';
export type { PlainHeaders } from './verifyWebhook.js';

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
