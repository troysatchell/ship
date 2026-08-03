/**
 * Agent service entrypoint (TRO-313 / FG-2).
 *
 * LangSmith tracing is controlled entirely by env vars
 * (`LANGCHAIN_TRACING_V2`, `LANGCHAIN_PROJECT`, `LANGCHAIN_API_KEY` /
 * `LANGSMITH_API_KEY`, `LANGCHAIN_ENDPOINT`) that `@langchain/core` reads
 * itself — there is nothing to wire up here beyond loading `.env` before
 * anything else runs, and warning loudly if tracing looks off, since the
 * brief requires traces from the first invocation, not bolted on later.
 */

import 'dotenv/config';
import { loadConfig, isConfigComplete } from './config.js';
import { createServer } from './server.js';

const config = loadConfig();

if (!config.langchainTracingV2) {
  console.warn(
    '[agent] LANGCHAIN_TRACING_V2 is not "true" — LangSmith tracing is OFF. ' +
      'Set it before invoking the graph if a trace is expected.'
  );
}

if (!isConfigComplete(config)) {
  console.warn(
    '[agent] Startup config is incomplete (ANTHROPIC_API_KEY and/or SHIP_API_BASE_URL missing). ' +
      'The process will stay up — /health still returns 200 — but /ready will return 503 ' +
      'until the missing values are set (graceful degradation, FG-4).'
  );
}

const app = createServer(config);

app.listen(config.port, () => {
  console.log(`[agent] listening on :${config.port}`);
});
