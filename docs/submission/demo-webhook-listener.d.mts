// Type declarations for `demo-webhook-listener.mjs`'s exported reference-
// subscriber factory (PF-801 / TRO-447) — a plain `.mjs` file has no
// declaration of its own, so both `api/.../__tests__/webhooks.test.ts` and
// `e2e/webhook-idempotency-key-drill.spec.ts` (this repo's `strict` +
// `noImplicitAny` tsconfig applies to both) need this to import
// `createReferenceSubscriber` without an implicit `any` — see
// `lessons.md` rule 21 ("type the boundaries that hand you `any` without
// saying so").

export interface ReferenceSubscriberDelivery {
  payload: unknown;
  firstSeenAt: string;
  duplicateCount: number;
}

export type ReferenceSubscriberVerify = (
  signatureHeaderValue: string,
  rawBody: string,
  secret: string
) => boolean;

export interface ReferenceSubscriberDeliveryEvent {
  kind: 'processed' | 'duplicate' | 'rejected';
  idempotencyKey?: string;
  payload?: unknown;
  /** Only set for `kind: 'rejected'` — distinguishes a signature-verification
   *  failure from a missing/empty Idempotency-Key header. */
  reason?: string;
}

export interface CreateReferenceSubscriberOptions {
  secret: string;
  verify: ReferenceSubscriberVerify;
  onDelivery?: (event: ReferenceSubscriberDeliveryEvent) => void;
}

export interface ReferenceSubscriber {
  server: import('node:http').Server;
  /** `Idempotency-Key` -> delivery record. Read-only introspection. */
  deliveries: ReadonlyMap<string, ReferenceSubscriberDelivery>;
  wasDeduped(key: string): boolean;
  wasProcessed(key: string): boolean;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createReferenceSubscriber(options: CreateReferenceSubscriberOptions): ReferenceSubscriber;
