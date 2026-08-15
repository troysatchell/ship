import { z } from 'zod';

/**
 * The webhook wire contract this receiver understands — PLUGFORGE.MD §2.6's
 * event envelope, verified against `api/src/platform/webhooks/events.ts`'s
 * real registry (`eventSchema()`'s envelope + the `document.created`/
 * `issue.assigned` per-type `data` shapes) rather than assumed from prose.
 *
 * Deliberately NOT imported from `api/src/` — an `integrations/*` package's
 * only permitted runtime dependency is `@ship/sdk`
 * (`scripts/check-integration-deps.mjs`, PF-003/TRO-399), and reaching into
 * `api/src` even at the type level would defeat the point of a reference
 * integration: this is the PUBLIC wire contract, documented for any
 * third-party subscriber, not a private implementation detail this package
 * happens to share a monorepo with. A schema drift between this file and the
 * real registry would only ever surface as a real webhook this receiver
 * can't parse — exactly the failure mode a live demo run (README) is meant
 * to catch.
 */
const UuidSchema = z.string().uuid();

const envelopeSchema = <TType extends string, TData extends z.ZodTypeAny>(type: TType, data: TData) =>
  z.object({
    id: UuidSchema,
    type: z.literal(type),
    created_at: z.string(),
    workspace_id: UuidSchema,
    data,
  });

const documentCreatedSchema = envelopeSchema(
  'document.created',
  z.object({
    id: UuidSchema,
    document_type: z.string(),
    title: z.string(),
    created_by: UuidSchema.nullable(),
  })
);

const issueAssignedSchema = envelopeSchema(
  'issue.assigned',
  z.object({
    id: UuidSchema,
    assignee_id: UuidSchema.nullable(),
    previous_assignee_id: UuidSchema.nullable(),
  })
);

export type DocumentCreatedEvent = z.infer<typeof documentCreatedSchema>;
export type IssueAssignedEvent = z.infer<typeof issueAssignedSchema>;

/** The two event types this integration posts to Slack (PF-803's own AC —
 *  `document.created` / `issue.assigned`, not all 8 registry types). */
export type ShipWebhookEvent = DocumentCreatedEvent | IssueAssignedEvent;

/**
 * Parses a verified webhook body into one of the two handled event types, or
 * `null` for anything else (an unhandled event type from a subscription that
 * covers more than these two, or a malformed body). `null` is a normal,
 * silent no-op case — never an error — so a subscription can safely list
 * every event type Ship offers without this receiver rejecting deliveries it
 * simply doesn't act on.
 */
export function parseHandledEvent(body: unknown): ShipWebhookEvent | null {
  const asDocumentCreated = documentCreatedSchema.safeParse(body);
  if (asDocumentCreated.success) return asDocumentCreated.data;

  const asIssueAssigned = issueAssignedSchema.safeParse(body);
  if (asIssueAssigned.success) return asIssueAssigned.data;

  return null;
}
