import { useState, useCallback, type FormEvent } from 'react';
import { apiPost } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * In-context chat panel for the FleetGraph agent (TRO-320 / FG-9).
 *
 * Lives inside the existing Properties Sidebar (mounted from
 * PropertiesPanel.tsx) rather than a fifth panel or a standalone page — the
 * ticket's own constraint: "Chat interface must be embedded in context — no
 * standalone chatbot pages." Every question is seeded with the currently
 * open document's id automatically; the user never types "about this
 * issue" (this component takes no `question`-scoping prop at all, only
 * `documentId`).
 *
 * Calls POST /api/agent/chat (api/src/routes/agent.ts), which proxies to
 * the FleetGraph agent service. Renders every cited source with the reason
 * it was pulled in — FLEETGRAPH.MD: "It names every document it pulled in
 * and why. That is the trust mechanism." An answer that comes back with NO
 * cited sources is deliberately rendered as a failure state rather than a
 * normal answer, for the same reason: an uncited answer has nothing to
 * verify it, so it is not shown as though it were trustworthy.
 *
 * Degrades visibly (never an unresolving spinner) when the agent is
 * unreachable, not configured, or answers without evidence — matches FG-4's
 * established degradation contract on the outbound side, applied here to
 * this inbound surface.
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

type ChatState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'answered'; output: string; citedSources: AgentCitedSource[]; expansionCapped: boolean }
  | { status: 'degraded'; message: string };

const NOT_CONFIGURED_MESSAGE = "The agent isn't set up in this environment yet.";
const UNREACHABLE_MESSAGE = "Can't reach the agent right now. Try again in a bit.";
const NO_CITATIONS_MESSAGE =
  "The agent answered without pointing to any source documents, so this answer isn't shown as trustworthy. Try rephrasing the question.";

const ChevronDownIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
  </svg>
);

const ChevronRightIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
    <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
  </svg>
);

const ChatIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
    <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
  </svg>
);

interface AgentChatPanelProps {
  /** The document currently open. Seeds every question automatically —
   * this is the only document-identifying prop the component takes. */
  documentId: string;
}

export function AgentChatPanel({ documentId }: AgentChatPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<ChatState>({ status: 'idle' });

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = question.trim();
      if (!trimmed || state.status === 'loading') return;

      setState({ status: 'loading' });
      try {
        const res = await apiPost('/api/agent/chat', {
          seedDocumentId: documentId,
          question: trimmed,
        });

        if (res.status === 503) {
          setState({ status: 'degraded', message: NOT_CONFIGURED_MESSAGE });
          return;
        }
        if (!res.ok) {
          setState({ status: 'degraded', message: UNREACHABLE_MESSAGE });
          return;
        }

        const data = (await res.json()) as AgentChatSuccessResponse;
        if (!data.citedSources || data.citedSources.length === 0) {
          setState({ status: 'degraded', message: NO_CITATIONS_MESSAGE });
          return;
        }

        setState({
          status: 'answered',
          output: data.output,
          citedSources: data.citedSources,
          expansionCapped: data.expansionCapped,
        });
      } catch {
        setState({ status: 'degraded', message: UNREACHABLE_MESSAGE });
      }
    },
    [question, documentId, state.status]
  );

  const isLoading = state.status === 'loading';

  return (
    <div className="border-t border-border pt-4 mt-4">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        aria-controls="agent-chat-panel-content"
        className="flex items-center gap-2 w-full text-left text-sm font-medium text-foreground hover:text-accent"
      >
        {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <ChatIcon />
        <span>Ask FleetGraph</span>
      </button>

      {isExpanded && (
        <div id="agent-chat-panel-content" className="mt-3 space-y-3">
          <form onSubmit={handleSubmit}>
            <label htmlFor="agent-chat-question" className="sr-only">
              Ask a question about this document
            </label>
            <div className="flex gap-2">
              <input
                id="agent-chat-question"
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask about this document…"
                disabled={isLoading}
                className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm text-foreground placeholder:text-muted disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={isLoading || question.trim().length === 0}
                className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-text disabled:opacity-50"
              >
                Ask
              </button>
            </div>
          </form>

          <div role={state.status === 'degraded' ? 'alert' : 'status'}>
            {state.status === 'loading' && (
              <p className="text-sm text-muted italic">Thinking…</p>
            )}

            {state.status === 'degraded' && (
              <p className="text-sm text-red-400">{state.message}</p>
            )}

            {state.status === 'answered' && (
              <div className="space-y-2">
                <p className="text-sm text-foreground whitespace-pre-wrap">{state.output}</p>
                <div>
                  <span className="text-xs font-medium text-muted">Sources</span>
                  <ul className="mt-1 space-y-1">
                    {state.citedSources.map((source) => (
                      <li key={source.documentId} className="text-xs text-muted">
                        <span className="font-medium text-foreground">{source.title}</span>
                        {' — '}
                        {source.reason}
                      </li>
                    ))}
                  </ul>
                  {state.expansionCapped && (
                    <p className={cn('mt-1 text-[11px] italic text-muted')}>
                      There was more to explore than this answer could include.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
