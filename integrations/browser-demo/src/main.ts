import { ShipClient, type Document } from '@ship/sdk';
import { LocalStorageTokenStore } from './localStorageTokenStore.js';

/**
 * Ship browser SDK demo (PF-802, PLUGFORGE.MD §4). No secret ever touches
 * this bundle — `authorizationCodeFlow()` is a public-client PKCE flow
 * (RFC 7636), and the only credential this app holds is the access/refresh
 * token pair `LocalStorageTokenStore` persists after a successful exchange.
 *
 * `VITE_SHIP_CLIENT_ID` must name a `client_type = 'public'` `oauth_apps`
 * row whose `redirect_uris` includes this page's own origin — see README.md
 * for how to register one locally, and e2e/browser-demo-pkce.spec.ts for how
 * the test seeds one per run.
 */
/**
 * Config resolution: `window.__SHIP_DEMO_CONFIG__`, when present, wins over
 * the `VITE_SHIP_*` build-time env vars. This lets ONE pre-built `dist/`
 * bundle be pointed at a different API/client_id without a rebuild — used by
 * e2e/browser-demo-pkce.spec.ts (via Playwright's `addInitScript`, which
 * runs before this module) to target a fresh, per-worker API server and
 * seeded OAuth app, and equally useful for deploying the same static build
 * to more than one environment.
 */
interface ShipDemoConfig {
  clientId: string;
  apiBaseUrl: string;
  redirectUri?: string;
  scope?: string;
}
declare global {
  interface Window {
    __SHIP_DEMO_CONFIG__?: ShipDemoConfig;
  }
}
const injectedConfig = window.__SHIP_DEMO_CONFIG__;
const CLIENT_ID = injectedConfig?.clientId ?? import.meta.env.VITE_SHIP_CLIENT_ID;
const API_BASE_URL = injectedConfig?.apiBaseUrl ?? import.meta.env.VITE_SHIP_API_BASE_URL;
const REDIRECT_URI = injectedConfig?.redirectUri ?? import.meta.env.VITE_SHIP_REDIRECT_URI ?? window.location.origin + '/';
const SCOPE = injectedConfig?.scope ?? import.meta.env.VITE_SHIP_SCOPE ?? 'documents:read';

const tokenStore = new LocalStorageTokenStore();
const app = document.querySelector<HTMLDivElement>('#app');

function requireApp(): HTMLDivElement {
  if (!app) throw new Error('#app element missing from index.html');
  return app;
}

function renderConnect(): void {
  const root = requireApp();
  root.innerHTML = '';

  const heading = document.createElement('h1');
  heading.textContent = 'Ship Browser SDK Demo';
  root.appendChild(heading);

  const description = document.createElement('p');
  description.textContent = 'PKCE Authorization Code flow, @ship/sdk — no secret in this bundle.';
  root.appendChild(description);

  const button = document.createElement('button');
  button.id = 'connect';
  button.textContent = 'Connect to Ship';
  button.addEventListener('click', () => {
    // Leg 1 of authorizationCodeFlow(): navigates the browser away, so this
    // promise deliberately never resolves in a real browser (see
    // @ship/sdk's authorizationCodeFlow.ts header).
    void ShipClient.authorizationCodeFlow({
      baseUrl: API_BASE_URL,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      tokenStore,
    });
  });
  root.appendChild(button);
}

function renderError(error: unknown): void {
  const root = requireApp();
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = '';
  const pre = document.createElement('pre');
  pre.id = 'error';
  pre.textContent = message;
  root.appendChild(pre);
  renderConnect();
}

async function renderDocuments(client: ShipClient): Promise<void> {
  const root = requireApp();
  root.innerHTML = '';

  const heading = document.createElement('h1');
  heading.textContent = 'Your documents';
  root.appendChild(heading);

  const disconnect = document.createElement('button');
  disconnect.id = 'disconnect';
  disconnect.textContent = 'Disconnect';
  disconnect.addEventListener('click', () => {
    void tokenStore.clear().then(renderConnect);
  });
  root.appendChild(disconnect);

  const list = document.createElement('ul');
  list.id = 'documents';
  root.appendChild(list);

  // documents.iterate() — PF-402's async-iterator pagination, the ticket's
  // own named AC ("lists the user's documents via async iterator").
  let count = 0;
  const MAX_RENDERED = 50; // demo UI cap only; iterate() itself is unbounded
  for await (const doc of client.documents.iterate({ limit: 20 })) {
    if (count >= MAX_RENDERED) break;
    list.appendChild(renderDocumentItem(doc));
    count += 1;
  }

  if (count === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No documents visible to this token yet.';
    root.appendChild(empty);
  }
}

function renderDocumentItem(doc: Document): HTMLLIElement {
  const item = document.createElement('li');
  item.textContent = `[${doc.document_type}] ${doc.title}`;
  return item;
}

async function boot(): Promise<void> {
  const url = new URL(window.location.href);
  const hasAuthorizationResponse = url.searchParams.has('code') && url.searchParams.has('state');

  try {
    if (hasAuthorizationResponse) {
      // Leg 2: authorizationCodeFlow() sees code+state in location.href,
      // redeems them, and resolves with a working ShipClient.
      const client = await ShipClient.authorizationCodeFlow({
        baseUrl: API_BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        tokenStore,
      });
      // Drop ?code=&state= from the URL so a reload doesn't try to redeem
      // an already-spent code.
      window.history.replaceState({}, '', REDIRECT_URI);
      await renderDocuments(client);
      return;
    }

    const existing = await tokenStore.get();
    if (existing) {
      const client = new ShipClient({
        baseUrl: API_BASE_URL,
        token: existing.accessToken,
        clientId: CLIENT_ID,
        tokenStore,
      });
      await renderDocuments(client);
      return;
    }

    renderConnect();
  } catch (error) {
    // A failed leg-2 exchange (expired/already-used code, state mismatch)
    // leaves ?code=&state= sitting in the URL. Without clearing it here,
    // clicking "Connect to Ship" again would re-enter authorizationCodeFlow()
    // with those SAME stale params still in location.href, re-attempting a
    // doomed exchange instead of starting a fresh redirect — the user would
    // be stuck. Only reachable on this failure path; the success path above
    // already clears it after a real redemption.
    if (hasAuthorizationResponse) {
      window.history.replaceState({}, '', REDIRECT_URI);
    }
    renderError(error);
  }
}

void boot();
