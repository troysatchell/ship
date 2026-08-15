import type { ShipWebhookEvent } from './eventEnvelope.js';

/** The subset of a Slack `chat.postMessage` call this integration needs —
 *  matches `@slack/web-api`'s `ChatPostMessageArguments` shape closely
 *  enough to pass straight through, without this file importing that
 *  package's types (keeps message formatting testable with zero Slack SDK
 *  dependency). */
export interface SlackMessagePayload {
  text: string;
  blocks: ReadonlyArray<Record<string, unknown>>;
}

function section(text: string): Record<string, unknown> {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string): Record<string, unknown> {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

/**
 * Formats one of the two handled Ship webhook events into a Slack message.
 * Uses only the fields the wire payload actually carries (PF-803's own AC
 * names `document.created`/`issue.assigned`, not an enriched view fetched
 * back from Ship's API) — `issue.assigned`'s payload has no issue title
 * (verified against `api/src/platform/webhooks/events.ts`'s real schema),
 * so the message names the issue by id, not a title this receiver was never
 * given.
 */
export function formatSlackMessage(event: ShipWebhookEvent): SlackMessagePayload {
  if (event.type === 'document.created') {
    const { document_type, title, id } = event.data;
    return {
      text: `New ${document_type}: "${title}"`,
      blocks: [
        section(`*New ${document_type} created:* ${title}`),
        context(`\`${id}\` · workspace \`${event.workspace_id}\` · ${event.created_at}`),
      ],
    };
  }

  const { id, assignee_id, previous_assignee_id } = event.data;
  const assignmentText =
    assignee_id === null
      ? `unassigned (was \`${previous_assignee_id}\`)`
      : previous_assignee_id === null
        ? `assigned to \`${assignee_id}\``
        : `reassigned from \`${previous_assignee_id}\` to \`${assignee_id}\``;

  return {
    text: `Issue ${id} ${assignmentText}`,
    blocks: [
      section(`*Issue assignment changed:* ${assignmentText}`),
      context(`\`${id}\` · workspace \`${event.workspace_id}\` · ${event.created_at}`),
    ],
  };
}
