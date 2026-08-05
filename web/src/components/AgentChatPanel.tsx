import { useState, useCallback, useEffect, useRef, type FormEvent } from 'react';
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

const NOT_CONFIGURED_MESSAGE = "The agent isn't set up in this environment yet.";
const UNREACHABLE_MESSAGE = "Can't reach the agent right now. Try again in a bit.";
const NO_CITATIONS_MESSAGE =
  "The agent answered without pointing to any source documents, so this answer isn't shown as trustworthy. Try rephrasing the question.";
const NO_DOCUMENT_HINT = 'Open a document to ask about it';

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

  // Keep the newest exchange in view as answers stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchanges]);

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
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {exchanges.length === 0 && (
          <p className="text-sm text-muted">
            Ask about the document you have open — every answer names the documents it drew
            from and why.
          </p>
        )}

        {exchanges.map((ex, i) => {
          const isLatest = i === exchanges.length - 1;
          return (
            <div key={ex.id} className="space-y-2">
              <div>
                <p className="text-sm font-medium text-foreground">{ex.question}</p>
                <p className="text-[11px] text-muted">
                  Asked about: {ex.seedDocumentTitle ?? 'this document'}
                </p>
              </div>

              {ex.state === 'answered' && (
                <div className="space-y-2">
                  <p className="whitespace-pre-wrap text-sm text-foreground">{ex.output}</p>
                  <div>
                    <span className="text-xs font-medium text-muted">Sources</span>
                    <ul className="mt-1 space-y-1">
                      {(ex.citedSources ?? []).map((source) => (
                        <li key={source.documentId} className="text-xs text-muted">
                          <span className="font-medium text-foreground">{source.title}</span>
                          {' — '}
                          {source.reason}
                        </li>
                      ))}
                    </ul>
                    {ex.expansionCapped && (
                      <p className={cn('mt-1 text-[11px] italic text-muted')}>
                        There was more to explore than this answer could include.
                      </p>
                    )}
                  </div>
                </div>
              )}

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
        <div className="flex gap-2">
          <input
            id="agent-chat-question"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={documentId ? 'Ask about this document…' : NO_DOCUMENT_HINT}
            disabled={!documentId || isBusy}
            className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm text-foreground placeholder:text-muted disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!documentId || isBusy || question.trim().length === 0}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-text disabled:opacity-50"
          >
            Ask
          </button>
        </div>
      </form>
    </div>
  );
}
