/**
 * Mention resolution (TRO-317 / FG-5) — a structured lookup, no
 * interpretation (the ticket is explicit: "no model call in this ticket's
 * path").
 *
 * Two representations of "someone was mentioned" exist in Ship today,
 * verified against two different sources, and this module resolves both:
 *
 *  - Document bodies: a structured TipTap `mention` node, written by
 *    `web/src/components/editor/MentionExtension.ts`
 *    (`{ type: 'mention', attrs: { id, mentionType, ... } }`). `attrs.id`
 *    is a person DOCUMENT id: `MentionExtension`'s `command` copies it
 *    straight from `/api/search/mentions`'s `people[].id`, which the same
 *    file's `fetchMentionSuggestions` sets to `person.id`.
 *  - Comments: literal `@Full Name` text in a plain `TEXT` column. Verified
 *    two ways: `api/src/db/seed.ts`'s own FG-3 fixture comment says so
 *    outright ("the mention convention here is literal `@Full Name` text
 *    ... there is no structured TipTap mention mark on the
 *    comments.content TEXT column"), and
 *    `web/src/components/editor/CommentDisplay.tsx` backs it up — comment
 *    input is a plain `<input type="text">` with no mention plugin
 *    attached. This is the ONLY mention shape FG-3's seeded proof fixture
 *    (`testCase2_mention1`/`testCase2_mention2`) actually produces, so
 *    skipping it would leave the ticket's own proof fixture undetectable.
 */

interface TipTapNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  [key: string]: unknown;
}

/**
 * Walks a TipTap JSON document and returns every person-mention's
 * `attrs.id` (a person DOCUMENT id — callers resolve that to a user id
 * separately via the people directory). Defensive against malformed or
 * absent content (`null`, a non-doc shape, a body that failed to parse):
 * returns `[]` rather than throwing, since a document the agent can't parse
 * is not evidence of anything.
 */
export function extractPersonMentionDocIds(content: unknown): string[] {
  const ids: string[] = [];

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as TipTapNode;

    if (n.type === 'mention') {
      // MentionExtension.ts defaults `mentionType` to 'person' both in its
      // TipTap attribute definition and its parseHTML fallback — a mention
      // node with no explicit mentionType IS a person mention.
      const mentionType = n.attrs?.mentionType ?? 'person';
      const id = n.attrs?.id;
      if (mentionType === 'person' && typeof id === 'string' && id.length > 0) {
        ids.push(id);
      }
    }

    if (Array.isArray(n.content)) {
      for (const child of n.content) visit(child);
    }
  };

  visit(content);
  return ids;
}

/**
 * Matches literal `@Full Name` mentions in comment text against a known
 * people directory. Exact (case-sensitive) match on the literal convention
 * the seed fixture and the comment UI actually use — see module docstring.
 * Returns the matched people's DOCUMENT ids (same currency as
 * `extractPersonMentionDocIds`, so callers resolve both the same way).
 */
export function extractLiteralNameMentions(
  text: string,
  people: ReadonlyArray<{ id: string; name: string }>
): string[] {
  if (!text) return [];

  const matched = new Set<string>();
  for (const person of people) {
    if (!person.name || person.name.trim().length === 0) continue;
    if (text.includes(`@${person.name}`)) {
      matched.add(person.id);
    }
  }
  return [...matched];
}
