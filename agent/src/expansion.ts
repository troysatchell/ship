/**
 * The on-demand expansion walk (TRO-318 / FG-7) — deterministic candidate
 * discovery, ranking and prompt-assembly, with no model call anywhere in
 * this file. Composed of small, independently testable functions so
 * `graph.ts`'s nodes stay thin wrappers around them, matching `proactive.ts`
 * (FG-5)'s own structure.
 *
 * Ticket scope: "the graph walks outward as far as the question requires —
 * project, week, program, issues and their history, the people and their
 * other work, documents that mention it and documents it mentions, and what
 * changed recently" — with "relevance ranking with a hard cap on documents
 * pulled in" as "the single most important implementation constraint in the
 * whole design" (on-demand is 64% of projected spend, FLEETGRAPH.MD's Cost
 * Analysis).
 *
 * What this file does NOT cover, and why:
 *  - "documents it mentions" (forward `document_links`, i.e. the seed's OWN
 *    outbound links) has no Ship API endpoint — `backlinks.ts` only exposes
 *    the reverse direction (who links TO a document). `document_links` has
 *    0 rows in the current dev database (verified), so this is a real but
 *    currently-inert gap; adding the forward endpoint is a Ship API change,
 *    out of scope for an agent-only ticket. Noted in the PR/handoff.
 *  - Per-document `document_history` ("what changed recently") is only
 *    exposed per-type today (`GET /api/issues/:id/history`,
 *    `weekly-plans.ts`'s own `/:id/history`) — no generic
 *    `GET /api/documents/:id/history`. Left out of this ticket's walk
 *    rather than special-casing issues only; `commentSnippets` (below)
 *    already surfaces the "what recently happened" signal this ticket's
 *    proof cases actually need (a stalled issue, a comment on a different
 *    document). Flagged for FG-6, which needs exactly this and may be the
 *    ticket that adds the generic route.
 *  - Role-derivation (`roles.ts`, director/PM/engineer) is not used for
 *    ranking — read per the ticket's own "may or may not be relevant" note,
 *    and left out: FG-5's ranking need (who has authority to unblock an
 *    approval) does not translate into "whose documents are more relevant
 *    to THIS question," and inventing a role-weighted relevance score with
 *    no evidence behind it would be exactly the kind of derived-not-observed
 *    claim the provenance rules warn against.
 */
import type {
  AssigneeIssueSummary,
  BacklinkEntry,
  OnDemandShipClientLike,
  ShipDocument,
} from './shipClient.js';
import { isDocumentVisibleTo } from './visibility.js';

// ============================================================================
// Candidates and ranking
// ============================================================================

/** Every edge shape the walk can discover, tagged separately by direction —
 * forward and reverse of the SAME relationship type carry different
 * real-world meaning (e.g. forward `sprint` = "this issue's week"; reverse
 * `sprint` = "another issue in this week") and are ranked independently. */
export type EdgeType =
  | 'seed'
  | 'blocks_forward'
  | 'blocks_reverse'
  | 'parent_forward'
  | 'parent_reverse'
  | 'sprint_forward'
  | 'sprint_reverse'
  | 'project_forward'
  | 'project_reverse'
  | 'program_forward'
  | 'program_reverse'
  | 'assignee_other_work'
  | 'backlink'
  | 'unknown';

/** A document discovered but not yet visited. `hop` is the walk distance
 * from the seed (seed itself is hop 0); `sourceDocumentId` is the document
 * whose expansion produced this candidate (null only for candidates
 * produced directly from the seed's own hop-0 record, which is itself the
 * source — kept non-null in practice since `buildCandidatesFromDocument`
 * always has a concrete source). */
export interface ExpansionCandidate {
  documentId: string;
  reason: string;
  edgeType: EdgeType;
  hop: number;
  sourceDocumentId: string;
}

/** Relevance weight per edge type — higher wins when the hard cap forces a
 * choice. `blocks` outranks plain containment: the ticket's own worked
 * example (FLEETGRAPH.MD Test Case 6, "why is this stalled" needing "its
 * blocking issue") treats a blocker as the single most load-bearing piece of
 * context for exactly the question this path answers. Reverse edges (siblings
 * discovered by walking OUT from a container) rank below forward edges
 * (direct properties of the document itself) on the theory that "this
 * issue's own week" is more obviously relevant than "another issue that
 * happens to share it." Derived from the ticket's qualitative guidance, not
 * measured against real usage — there is no usage yet to measure against. */
const EDGE_WEIGHTS: Record<EdgeType, number> = {
  seed: 1000,
  blocks_forward: 100,
  blocks_reverse: 100,
  parent_forward: 90,
  parent_reverse: 90,
  sprint_forward: 85,
  project_forward: 80,
  program_forward: 60,
  backlink: 65,
  assignee_other_work: 50,
  sprint_reverse: 55,
  project_reverse: 45,
  program_reverse: 35,
  unknown: 40,
};

/** Per-hop decay so a direct edge from the seed always outranks an
 * equally-typed edge discovered two hops out — without this, a wide but
 * shallow neighbourhood and a narrow but deep one would tie on type alone. */
const HOP_PENALTY = 10;

export function scoreCandidate(candidate: Pick<ExpansionCandidate, 'edgeType' | 'hop'>): number {
  return (EDGE_WEIGHTS[candidate.edgeType] ?? EDGE_WEIGHTS.unknown) - candidate.hop * HOP_PENALTY;
}

/** Highest score first; ties broken by `documentId` (not insertion order or
 * any other mutable counter) so the sort is a pure function of its input —
 * the same candidate set always produces the same order, in this run or any
 * other. */
export function sortFrontierByRelevance(frontier: readonly ExpansionCandidate[]): ExpansionCandidate[] {
  return [...frontier].sort((a, b) => {
    const diff = scoreCandidate(b) - scoreCandidate(a);
    if (diff !== 0) return diff;
    return a.documentId.localeCompare(b.documentId);
  });
}

// ============================================================================
// Reason text
// ============================================================================

type ReasonFn = (sourceTitle: string) => string;

const FORWARD_REASONS: Record<string, { edgeType: EdgeType; reason: ReasonFn }> = {
  blocks: { edgeType: 'blocks_forward', reason: (t) => `is blocked by "${t}"` },
  parent: { edgeType: 'parent_forward', reason: (t) => `is the parent issue of "${t}"` },
  sprint: { edgeType: 'sprint_forward', reason: (t) => `is the week "${t}" belongs to` },
  project: { edgeType: 'project_forward', reason: (t) => `is the project "${t}" belongs to` },
  program: { edgeType: 'program_forward', reason: (t) => `is the program "${t}" belongs to` },
};

const REVERSE_REASONS: Record<string, { edgeType: EdgeType; reason: ReasonFn }> = {
  blocks: { edgeType: 'blocks_reverse', reason: (t) => `blocks "${t}"` },
  parent: { edgeType: 'parent_reverse', reason: (t) => `is a sub-issue of "${t}"` },
  sprint: { edgeType: 'sprint_reverse', reason: (t) => `is in the same week as "${t}"` },
  project: { edgeType: 'project_reverse', reason: (t) => `is in the same project as "${t}"` },
  program: { edgeType: 'program_reverse', reason: (t) => `is in the same program as "${t}"` },
};

function classify(
  table: Record<string, { edgeType: EdgeType; reason: ReasonFn }>,
  relationshipType: string
): { edgeType: EdgeType; reason: ReasonFn } {
  return (
    table[relationshipType] ?? {
      edgeType: 'unknown',
      // Forward-compatible with a relationship_type this file has never
      // heard of — the enum has already grown once this sprint ('blocks',
      // FG-15/TRO-333). An unrecognized type still becomes a citable,
      // reasoned candidate rather than being silently dropped.
      reason: (t: string) => `is related to "${t}" (${relationshipType})`,
    }
  );
}

// ============================================================================
// Candidate discovery
// ============================================================================

const DEFAULT_ASSIGNEE_CANDIDATE_LIMIT = 5;

/** Everything the walk needs to decide the next hop's candidates, and to
 * bound how much of one person's work it pulls in per visit. Kept separate
 * from `OnDemandDeps` (`graph.ts`) so this file has no dependency on
 * LangGraph's `Annotation`/state shape — it only needs a client and a
 * number. */
export interface CandidateDiscoveryOptions {
  assigneeCandidateLimit?: number;
}

/**
 * Discovers the next hop's candidates from a just-visited document: its
 * forward associations (this issue's week/project/program/blocker), the
 * associations pointing at it (siblings in the same week/project, the issue
 * that blocks it), documents that mention it (backlinks), and — for issues
 * only — a bounded slice of the same assignee's other work.
 *
 * Deliberately fetches all four sources in parallel (`Promise.all`): none
 * depends on another's result, and this is exactly the shape that makes an
 * on-demand run's node timing (and LangSmith trace) look structurally
 * different from FG-5's linear proactive chain — a real property of the
 * graph, not a cosmetic one.
 */
export async function buildCandidatesFromDocument(
  client: OnDemandShipClientLike,
  doc: ShipDocument,
  hop: number,
  options: CandidateDiscoveryOptions = {}
): Promise<ExpansionCandidate[]> {
  const assigneeId = typeof doc.properties.assignee_id === 'string' ? doc.properties.assignee_id : undefined;

  const [forward, reverse, backlinks, assigneeIssues] = await Promise.all([
    client.getAssociations(doc.id),
    client.getReverseAssociations(doc.id),
    client.getBacklinks(doc.id),
    doc.document_type === 'issue' && assigneeId
      ? client.getIssuesByAssignee(assigneeId, options.assigneeCandidateLimit ?? DEFAULT_ASSIGNEE_CANDIDATE_LIMIT)
      : Promise.resolve<AssigneeIssueSummary[]>([]),
  ]);

  const candidates: ExpansionCandidate[] = [];

  for (const edge of forward) {
    const { edgeType, reason } = classify(FORWARD_REASONS, edge.relationship_type);
    candidates.push({
      documentId: edge.related_id,
      reason: reason(doc.title),
      edgeType,
      hop,
      sourceDocumentId: doc.id,
    });
  }

  for (const edge of reverse) {
    const { edgeType, reason } = classify(REVERSE_REASONS, edge.relationship_type);
    candidates.push({
      documentId: edge.document_id,
      reason: reason(doc.title),
      edgeType,
      hop,
      sourceDocumentId: doc.id,
    });
  }

  for (const bl of backlinks as BacklinkEntry[]) {
    candidates.push({
      documentId: bl.id,
      reason: `mentions "${doc.title}"`,
      edgeType: 'backlink',
      hop,
      sourceDocumentId: doc.id,
    });
  }

  for (const issue of assigneeIssues) {
    if (issue.id === doc.id) continue;
    candidates.push({
      documentId: issue.id,
      reason: `is also assigned to whoever owns "${doc.title}"`,
      edgeType: 'assignee_other_work',
      hop,
      sourceDocumentId: doc.id,
    });
  }

  return candidates;
}

// ============================================================================
// Visited documents, evidence and citations
// ============================================================================

/** A document the walk successfully pulled into context — the seam FG-6's
 * "what actually moved" composition can reuse directly (see graph.ts's
 * handoff notes): this already IS "a document, why it's relevant, and its
 * recent comment activity," gathered the same way a standup draft would
 * need it. */
export interface ExpandedDocument {
  documentId: string;
  documentType: string;
  title: string;
  reason: string;
  hop: number;
  textSnippet: string;
  commentSnippets: string[];
}

/** The output-facing citation — "It names every document it pulled in and
 * why" (the ticket's trust mechanism). Deliberately a 1:1 projection of
 * `ExpandedDocument`: everything pulled into context is cited, full stop —
 * there is no separate "the model chose not to mention this one" filter,
 * because that would let an answer quietly omit a source it read. */
export interface CitedSource {
  documentId: string;
  documentType: string;
  title: string;
  reason: string;
}

export function buildCitedSources(expandedDocuments: readonly ExpandedDocument[]): CitedSource[] {
  return expandedDocuments.map(({ documentId, documentType, title, reason }) => ({
    documentId,
    documentType,
    title,
    reason,
  }));
}

const DEFAULT_COMMENT_SNIPPET_LIMIT = 3;
const COMMENT_SNIPPET_MAX_CHARS = 200;

/** Comments on a just-visited document, most recent first, truncated so the
 * prompt stays bounded regardless of how long a thread is. Never throws —
 * a comments fetch failing is not evidence of anything the walk can act on,
 * same posture as `proactive.ts`'s `tryGetDocument`. */
export async function fetchCommentSnippets(
  client: Pick<OnDemandShipClientLike, 'getComments'>,
  documentId: string,
  limit = DEFAULT_COMMENT_SNIPPET_LIMIT
): Promise<string[]> {
  let comments;
  try {
    comments = await client.getComments(documentId);
  } catch {
    return [];
  }
  return [...comments]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map((c) => {
      const text = c.content.length > COMMENT_SNIPPET_MAX_CHARS ? `${c.content.slice(0, COMMENT_SNIPPET_MAX_CHARS)}…` : c.content;
      return `${c.author.name}: ${text}`;
    });
}

/** `visitDocument`'s success result — both the output-facing record AND the
 * raw fetched document, so a caller (`graph.ts`'s `resolveSeed`/
 * `expandFrontier`) can pass `doc` straight into `buildCandidatesFromDocument`
 * without a second, redundant `getDocument` call for the same id. */
export interface VisitedDocument {
  record: ExpandedDocument;
  doc: ShipDocument;
}

/**
 * Resolves one candidate document id into a `VisitedDocument`, or
 * `undefined` if it should never be surfaced — gone, unreachable, or not
 * visible to the asking user. Two independent gates, in order:
 *  1. `getDocument` itself — the PRIMARY guarantee. Ship's own
 *     `GET /api/documents/:id` 404s for a document this token's user cannot
 *     see (`documents.ts`'s `canAccessDocument`), and the agent runs under
 *     that user's own token (FLEETGRAPH.MD: "no service account"), so most
 *     invisible candidates never even get this far.
 *  2. `passesAskerVisibility` — belt-and-braces (see that function's own
 *     docstring for exactly what it catches that (1) alone would not).
 *
 * Never throws: any failure from either the document fetch or the comments
 * fetch is treated as "not evidence of anything," matching
 * `proactive.ts`'s `tryGetDocument` posture exactly.
 */
export async function visitDocument(
  client: Pick<OnDemandShipClientLike, 'getDocument' | 'getComments'>,
  documentId: string,
  candidate: { reason: string; hop: number },
  askingUserId: string | undefined,
  commentSnippetLimit?: number
): Promise<VisitedDocument | undefined> {
  let doc: ShipDocument;
  try {
    doc = await client.getDocument(documentId);
  } catch {
    return undefined;
  }

  if (!passesAskerVisibility(doc, askingUserId)) {
    return undefined;
  }

  const commentSnippets = await fetchCommentSnippets(client, documentId, commentSnippetLimit);

  return {
    doc,
    record: {
      documentId: doc.id,
      documentType: doc.document_type,
      title: doc.title,
      reason: candidate.reason,
      hop: candidate.hop,
      textSnippet: extractPlainText(doc.content),
      commentSnippets,
    },
  };
}

// ============================================================================
// Plain-text extraction (for prompt context, not a full renderer)
// ============================================================================

interface TipTapLikeNode {
  type?: string;
  text?: string;
  content?: unknown[];
}

function isTipTapLikeNode(value: unknown): value is TipTapLikeNode {
  return typeof value === 'object' && value !== null;
}

/**
 * Best-effort plain text out of a TipTap document body, for feeding the
 * model short context rather than raw JSON. Deliberately minimal — walks
 * `content` arrays and collects `text` nodes' `.text`, nothing more (no
 * heading/list formatting, no marks). Good enough for prompt grounding; NOT
 * a fidelity claim about the document's actual rendered content.
 */
export function extractPlainText(content: unknown, maxLen = 400): string {
  const parts: string[] = [];

  function walk(node: unknown): void {
    if (!isTipTapLikeNode(node)) return;
    if (node.type === 'text' && typeof node.text === 'string') {
      parts.push(node.text);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  }

  walk(content);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

// ============================================================================
// Prompt assembly
// ============================================================================

/**
 * Builds the text handed to `model.invoke` — the question plus every
 * expanded document's title/type/reason, its short text snippet, and its
 * comment snippets. Citations are NOT produced by asking the model to list
 * its sources: `citedSources` (built by `buildCitedSources`, above) is
 * derived from the SAME `expandedDocuments` list independently of anything
 * the model writes, so a source's presence in the citation list never
 * depends on the model choosing to mention it in prose ("citations are
 * structural, not a suffix" — TRO-318's design guidance).
 */
export function buildExpansionPrompt(question: string, expandedDocuments: readonly ExpandedDocument[]): string {
  if (expandedDocuments.length === 0) {
    return [
      `Question: ${question.trim()}`,
      '',
      'No accessible document could be resolved to answer from — the document that seeded this ' +
        'question could not be read (missing, or not visible to the person asking).',
      'Say so plainly rather than guessing.',
    ].join('\n');
  }

  const sections = expandedDocuments.map((d, i) => {
    const lines = [`[${i + 1}] ${d.documentType} "${d.title}" — pulled in because: ${d.reason}`];
    if (d.textSnippet) lines.push(`    content: ${d.textSnippet}`);
    for (const snippet of d.commentSnippets) lines.push(`    comment — ${snippet}`);
    return lines.join('\n');
  });

  return [
    `Question: ${question.trim()}`,
    '',
    'Context gathered by following the graph outward from the open document:',
    ...sections,
    '',
    'Answer the question using only the context above. Where a document above informed the ' +
      'answer, refer to it by its bracketed number.',
  ].join('\n');
}

/** The deterministic, code-generated note appended when the hard cap
 * stopped the walk before the frontier ran out on its own — "says so rather
 * than truncating silently" (TRO-318, proof #2). Appended by CODE, not
 * asked of the model, for the same reason citations are structural: a cap
 * notice the model might or might not remember to mention is not a
 * guarantee. */
export function capNoticeText(documentCap: number): string {
  return `\n\n(Reached the ${documentCap}-document limit for this answer — some related documents were not explored.)`;
}

// ============================================================================
// Visibility (defense in depth)
// ============================================================================

/** Re-checks a fetched document against the asking user's visibility,
 * reusing FG-5's exact mechanism (`isDocumentVisibleTo`) rather than
 * inventing a second one — see TRO-318's own instruction to do so. This is
 * belt-and-braces on top of `GET /api/documents/:id` already 404-ing for a
 * document the caller's own token cannot see (the primary guarantee, "it
 * can reach anything you could reach, and nothing you could not"): a
 * document that comes back from `getDocument` is *supposed* to already be
 * visible, but `associations.ts`'s forward/reverse endpoints leak a
 * candidate's title without checking the CANDIDATE's own visibility (only
 * the anchor document's), so this second check is what actually stops a
 * leaked candidate id from being trusted once it IS fetched.
 * `askingUserId` is optional: when the caller hasn't wired it through yet
 * (e.g. before FG-9's chat panel exists to supply it), this check is
 * skipped and the walk relies solely on the server-side 404 — a real but
 * strictly smaller guarantee, never a silent bypass of one that exists. */
export function passesAskerVisibility(doc: ShipDocument, askingUserId: string | undefined): boolean {
  if (!askingUserId) return true;
  return isDocumentVisibleTo(doc, askingUserId);
}
