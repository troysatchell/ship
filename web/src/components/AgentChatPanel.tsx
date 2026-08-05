import { useState, useCallback, useEffect, useMemo, useRef, type FormEvent } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { apiPost } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * In-context chat for the FleetGraph agent (TRO-320 / FG-9; reshaped by the
 * 2026-08-05 agent-pill design — docs/superpowers/specs/).
 *
 * Rendered inside the floating AgentPill card (components/agent/AgentPill.tsx)
 * rather than the Properties Sidebar accordion it originally shipped as. The
 * ticket's constraint is unchanged: "Chat interface must be embedded in
 * context — no standalone chatbot pages." Every question is seeded with the
 * currently open document's id automatically; the user never types "about
 * this issue" (no `question`-scoping prop exists, only `documentId`). On
 * screens with no open document the input is disabled with a hint — the API
 * requires a seed document (api/src/routes/agent.ts rejects without one).
 *
 * History is an append-only, session-only list of exchanges. It survives
 * navigation: each exchange is tagged with the document it was seeded on, so
 * a response landing after the user has moved to another document is
 * appended under its own tag rather than shown under the wrong document's
 * context (the same mismatch the old discard-on-navigation guard existed to
 * prevent, kept honest by the tag instead of by throwing the answer away).
 *
 * Degrades visibly (never an unresolving spinner) when the agent is
 * unreachable, not configured, or answers without evidence — an answer with
 * NO cited sources is deliberately rendered as a failure state, because an
 * uncited answer has nothing to verify it (FLEETGRAPH.MD: "It names every
 * document it pulled in and why. That is the trust mechanism.").
 */

export interface AgentCitedSource {
  documentId: string;
  documentType: string;
  title: string;
  reason: string;
}

interface AgentChatSuccessResponse {
  output: string;
  citedSources: AgentCitedSource[];
  expansionCapped: boolean;
}

interface ChatExchange {
  id: number;
  question: string;
  seedDocumentId: string;
  seedDocumentTitle: string | null;
  state: 'loading' | 'answered' | 'degraded';
  output?: string;
  citedSources?: AgentCitedSource[];
  expansionCapped?: boolean;
  message?: string;
}

const ArrowRightIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
    <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h9.69L10.22 6.03a.75.75 0 111.06-1.06l4.5 4.5a.75.75 0 010 1.06l-4.5 4.5a.75.75 0 11-1.06-1.06l3.22-3.22H3.75A.75.75 0 013 10z" clipRule="evenodd" />
  </svg>
);

const NOT_CONFIGURED_MESSAGE = "The agent isn't set up in this environment yet.";
const UNREACHABLE_MESSAGE = "Can't reach the agent right now. Try again in a bit.";
const NO_CITATIONS_MESSAGE =
  "The agent answered without pointing to any source documents, so this answer isn't shown as trustworthy. Try rephrasing the question.";
const NO_DOCUMENT_HINT = 'Open a document to ask about it';

/** Per-word reveal cadence. The full answer is already in hand (the API is
 * single-turn JSON, not a wire stream) — this is presentation-layer
 * streaming, the words resolving out of blur. */
const WORD_MS = 30;

/** A word plus the whitespace that follows it. */
function tokenizeWords(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/* ── Lightweight markdown for agent answers ────────────────────────────────
 * The model emits a small, predictable subset — `**bold**`, `#`/`##`/`###`
 * headings, `-` list items, and numeric citation refs like `[3]` that index
 * into the cited-sources list below the answer. Parsed here by hand (scoped
 * to exactly that subset) rather than pulling a markdown dependency into the
 * bundle for four constructs. Raw markers never reach the screen — parsing
 * happens BEFORE the word-by-word reveal, so `**` is invisible even
 * mid-stream. */

interface AnswerSeg {
  text: string;
  bold?: boolean;
  cite?: boolean;
  words: string[];
}

interface AnswerLine {
  kind: 'h' | 'li' | 'p';
  segs: AnswerSeg[];
  /** Global word range [start, end) — drives the streaming reveal. */
  start: number;
  end: number;
}

function parseInline(text: string): Omit<AnswerSeg, 'words'>[] {
  return text
    .split(/(\*\*[^*]+\*\*|\[[0-9]+(?:\s*[-–,]\s*[0-9]+)*\])/g)
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return { text: part.slice(2, -2), bold: true };
      }
      if (part.startsWith('[')) {
        return { text: part, cite: true };
      }
      return { text: part };
    });
}

function parseAnswer(output: string): AnswerLine[] {
  let counter = 0;
  return output
    .split('\n')
    .map((raw) => raw.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      let kind: AnswerLine['kind'] = 'p';
      let body = line;
      const heading = line.match(/^#{1,3}\s+(.*)$/);
      if (heading?.[1] !== undefined) {
        kind = 'h';
        body = heading[1];
      } else if (/^[-*]\s+/.test(line)) {
        kind = 'li';
        body = line.replace(/^[-*]\s+/, '');
      }
      const segs = parseInline(body).map((seg) => ({ ...seg, words: tokenizeWords(seg.text) }));
      const start = counter;
      counter += segs.reduce((n, seg) => n + seg.words.length, 0);
      return { kind, segs, start, end: counter };
    });
}

function segClassName(seg: AnswerSeg): string | undefined {
  if (seg.cite) return 'align-super text-[10px] text-muted';
  if (seg.bold) return 'font-semibold';
  return undefined;
}

/** One inline segment, either whole (done) or clipped to the reveal front. */
function SegSpan({ seg, from, to }: { seg: AnswerSeg; from: number; to: number }) {
  const cls = segClassName(seg);
  if (to >= seg.words.length && from <= 0) {
    return <span className={cls}>{seg.text}</span>;
  }
  return (
    <span className={cls}>
      {seg.words.slice(Math.max(0, from), Math.max(0, to)).map((word, i) => (
        <span key={i} style={{ animation: 'agent-word-in 250ms ease-out both' }}>
          {word}
        </span>
      ))}
    </span>
  );
}

/**
 * One answered exchange: streams the text word by word on first render (the
 * markdown is parsed first, so markers never flash on screen), then settles
 * into whole styled text nodes. The sources block fades in only once the
 * text completes — reading order is top to bottom, so nothing below the
 * text should demand attention before the text is done. Deliberately NO
 * auto-scroll anywhere.
 */
function AnswerBlock({ exchange }: { exchange: ChatExchange }) {
  const output = exchange.output ?? '';
  const lines = useMemo(() => parseAnswer(output), [output]);
  const totalWords = lines[lines.length - 1]?.end ?? 0;
  const [revealed, setRevealed] = useState(0);
  const done = revealed >= totalWords;

  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => setRevealed((c) => c + 1), WORD_MS);
    return () => clearTimeout(t);
  }, [revealed, done]);

  const cursor = (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 rounded-full bg-foreground"
    />
  );

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {lines.map((line, li) => {
          // Lines beyond the reveal front don't exist yet; the line the
          // front sits inside carries the cursor.
          if (!done && line.start > revealed) return null;
          const streamingHere = !done && revealed >= line.start && revealed < line.end;
          const content = (
            <>
              {line.segs.map((seg, si) => {
                // Per-segment window in this line's local word coordinates.
                const segStart = line.segs.slice(0, si).reduce((n, s) => n + s.words.length, line.start);
                return done ? (
                  <SegSpan key={si} seg={seg} from={0} to={seg.words.length} />
                ) : (
                  <SegSpan key={si} seg={seg} from={0} to={revealed - segStart} />
                );
              })}
              {streamingHere && cursor}
            </>
          );
          if (line.kind === 'h') {
            return (
              <p key={li} className="mt-2 text-sm font-semibold text-foreground first:mt-0">
                {content}
              </p>
            );
          }
          if (line.kind === 'li') {
            return (
              <p key={li} className="flex gap-1.5 text-sm text-foreground">
                <span aria-hidden="true" className="text-muted">
                  •
                </span>
                <span>{content}</span>
              </p>
            );
          }
          return (
            <p key={li} className="text-sm text-foreground">
              {content}
            </p>
          );
        })}
      </div>

      {done && (
        <div style={{ animation: 'agent-fade-in 350ms ease-out both' }}>
          <span className="text-xs font-medium text-muted">Sources</span>
          <ol className="mt-1 space-y-1">
            {(exchange.citedSources ?? []).map((source, i) => (
              <li key={source.documentId} className="text-xs text-muted">
                <span className="text-muted">{i + 1}.</span>{' '}
                <span className="font-medium text-foreground">{source.title}</span>
                {' — '}
                {source.reason}
              </li>
            ))}
          </ol>
          {exchange.expansionCapped && (
            <p className={cn('mt-1 text-[11px] italic text-muted')}>
              There was more to explore than this answer could include.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface AgentChatPanelProps {
  /** The document currently open, or null on screens without one. Seeds
   * every question automatically — the only document-identifying prop. */
  documentId: string | null;
  /** Title of the open document, shown in the context chip and recorded on
   * each exchange's tag. Falls back to "this document" when unknown. */
  documentTitle?: string | null;
  /** Reports whether a request is in flight — the pill's header orb
   * animates off this. */
  onBusyChange?: (busy: boolean) => void;
}

export function AgentChatPanel({ documentId, documentTitle, onBusyChange }: AgentChatPanelProps) {
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<ChatExchange[]>([]);
  const nextIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isBusy = exchanges.some((ex) => ex.state === 'loading');

  useEffect(() => {
    onBusyChange?.(isBusy);
  }, [isBusy, onBusyChange]);

  // Reading order is top to bottom: NEVER auto-scroll while an answer
  // streams. The one scroll that happens is a single snap when a NEW
  // question is submitted — it puts that question at the top of the
  // viewport so its answer streams downward from there.
  const latestExchangeRef = useRef<HTMLDivElement>(null);
  const prevExchangeCountRef = useRef(0);
  useEffect(() => {
    if (exchanges.length > prevExchangeCountRef.current) {
      const container = scrollRef.current;
      const el = latestExchangeRef.current;
      if (container && el) container.scrollTop = el.offsetTop;
    }
    prevExchangeCountRef.current = exchanges.length;
  }, [exchanges.length]);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = question.trim();
      if (!trimmed || !documentId || isBusy) return;

      const id = nextIdRef.current++;
      setExchanges((prev) => [
        ...prev,
        {
          id,
          question: trimmed,
          seedDocumentId: documentId,
          seedDocumentTitle: documentTitle ?? null,
          state: 'loading',
        },
      ]);
      setQuestion('');

      // Updates THIS exchange by id, wherever it now sits in the list — a
      // response that lands after the user navigated away is appended under
      // the document it was actually asked about, never the current one.
      const finish = (patch: Partial<ChatExchange>) => {
        setExchanges((prev) => prev.map((ex) => (ex.id === id ? { ...ex, ...patch } : ex)));
      };

      try {
        const res = await apiPost('/api/agent/chat', {
          seedDocumentId: documentId,
          question: trimmed,
        });

        if (res.status === 503) {
          finish({ state: 'degraded', message: NOT_CONFIGURED_MESSAGE });
          return;
        }
        if (!res.ok) {
          finish({ state: 'degraded', message: UNREACHABLE_MESSAGE });
          return;
        }

        const data = (await res.json()) as AgentChatSuccessResponse;
        if (!data.citedSources || data.citedSources.length === 0) {
          finish({ state: 'degraded', message: NO_CITATIONS_MESSAGE });
          return;
        }

        finish({
          state: 'answered',
          output: data.output,
          citedSources: data.citedSources,
          expansionCapped: data.expansionCapped,
        });
      } catch {
        finish({ state: 'degraded', message: UNREACHABLE_MESSAGE });
      }
    },
    [question, documentId, documentTitle, isBusy]
  );

  const latest = exchanges.length > 0 ? exchanges[exchanges.length - 1] : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* `relative` so exchange offsetTop is measured against this container
        * for the submit-time snap below. */}
      <div ref={scrollRef} className="scrollbar-none relative min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {exchanges.length === 0 && (
          <p className="text-sm text-muted">
            Ask about the document you have open — every answer names the documents it drew
            from and why.
          </p>
        )}

        {exchanges.map((ex, i) => {
          const isLatest = i === exchanges.length - 1;
          return (
            <div key={ex.id} ref={isLatest ? latestExchangeRef : undefined} className="space-y-2">
              <div>
                <p className="text-sm font-medium text-foreground">{ex.question}</p>
                <p className="text-[11px] text-muted">
                  Asked about: {ex.seedDocumentTitle ?? 'this document'}
                </p>
              </div>

              {ex.state === 'answered' && <AnswerBlock exchange={ex} />}

              {/* The LATEST degraded exchange renders through the role="alert"
                * live region below instead, so assistive technology announces
                * it; older ones are history and render inline. */}
              {ex.state === 'degraded' && !isLatest && (
                <p className="text-sm text-red-400">{ex.message}</p>
              )}
            </div>
          );
        })}

        {/* Two sibling live regions, each with a role FIXED for the lifetime
          * of the element, rather than one region whose role is switched
          * between "status" and "alert" depending on state — a region whose
          * politeness changes with its own content is unreliably announced
          * by assistive technology, since a live region's announcement
          * behavior is generally established when it is inserted, not
          * re-evaluated cleanly on every attribute change. */}
        <div role="alert">
          {latest?.state === 'degraded' && (
            <p className="text-sm text-red-400">{latest.message}</p>
          )}
        </div>

        <div role="status">
          {latest?.state === 'loading' && (
            <p className="flex items-center gap-2 text-sm italic text-muted">
              <ThinkingOrb state="solving" size={20} />
              Thinking…
            </p>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="border-t border-border p-3">
        <p className="mb-2 truncate text-[11px] text-muted">
          {documentId ? (
            <>
              Asking about:{' '}
              <span className="font-medium text-foreground">
                {documentTitle ?? 'this document'}
              </span>
            </>
          ) : (
            NO_DOCUMENT_HINT
          )}
        </p>
        <label htmlFor="agent-chat-question" className="sr-only">
          Ask a question about this document
        </label>
        {/* Pill-shaped composer: the submit control is a circular arrow
          * INSIDE the input's right end, not a separate labelled button —
          * `aria-label="Ask"` keeps its accessible name. */}
        <div className="relative">
          <input
            id="agent-chat-question"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={documentId ? 'Ask about this document…' : NO_DOCUMENT_HINT}
            disabled={!documentId || isBusy}
            className="w-full rounded-full border border-border bg-transparent py-1.5 pl-4 pr-11 text-sm text-foreground placeholder:text-muted disabled:opacity-50"
          />
          <button
            type="submit"
            aria-label="Ask"
            disabled={!documentId || isBusy || question.trim().length === 0}
            className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-accent-text transition-opacity disabled:opacity-40"
          >
            <ArrowRightIcon />
          </button>
        </div>
      </form>
    </div>
  );
}
