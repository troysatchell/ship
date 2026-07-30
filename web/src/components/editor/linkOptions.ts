/**
 * The single link-href policy shared by every TipTap editor in the app.
 *
 * Why this file exists (audit finding TEST-2 / TRO-224).
 *
 * `e2e/security.spec.ts` carried two tests named for link XSS — "XSS via
 * markdown link injection" and "XSS via data: URI in links". Both typed a
 * markdown link into the editor and then looped over the rendered `<a>`
 * elements. TipTap has no markdown-link input rule, so **no `<a>` was ever
 * created**, the loop body never ran, and both tests went green without
 * observing anything. The only automated coverage of the stored-XSS-via-href
 * vector was a no-op.
 *
 * The protection itself is real, but it was inherited silently from
 * `@tiptap/extension-link`'s default `isAllowedUri`, which allows only
 * http/https/ftp/ftps/mailto/tel/callto/sms/cid/xmpp and strips the `href` of
 * anything else during `renderHTML`. Two things could remove it without anyone
 * noticing: adding a scheme to `protocols`, or overriding `isAllowedUri`.
 * Neither would fail a test, because there was no test.
 *
 * So the policy is named, exported, and pinned by `linkOptions.test.ts` (which
 * the factory gate runs — `e2e/` is not executed by the gate or CI). The
 * explicit deny-list below is defence in depth: every scheme in it is already
 * rejected by `defaultValidate`, so this is a no-op against today's
 * `@tiptap/extension-link` (2.27.2) and a guard against tomorrow's.
 */
import type { LinkOptions } from '@tiptap/extension-link';

/**
 * Schemes that must never survive into a rendered `href`, whatever else
 * changes. `data:` is included wholesale rather than only `data:text/html`
 * because `data:image/svg+xml` executes script too.
 */
export const DENIED_LINK_SCHEMES = ['javascript', 'data', 'vbscript', 'file', 'blob'] as const;

const DENIED_SCHEME_RE = new RegExp(`^(?:${DENIED_LINK_SCHEMES.join('|')}):`, 'i');

/**
 * Whitespace and C0/C1 control characters, which browsers discard while parsing
 * a URL's scheme. Both `jav\tascript:alert(1)` and `java\nscript:alert(1)` are
 * live links in a rendered document, so they have to be removed before the
 * scheme is compared — matching on the raw string would miss them.
 */
const IGNORABLE_IN_SCHEME = /[\s\u0000-\u001f\u007f-\u009f]+/g;

/** True when `url` uses one of {@link DENIED_LINK_SCHEMES}. */
export function usesDeniedScheme(url: string | null | undefined): boolean {
  if (!url) return false;
  return DENIED_SCHEME_RE.test(url.replace(IGNORABLE_IN_SCHEME, ''));
}

/**
 * Options every `Link.configure(...)` call in the app must spread.
 *
 * Deliberately does NOT set `openOnClick`: the document editor opens links on
 * click, the standup composer does not, and that difference is a UX choice
 * rather than a security one. Callers set it themselves.
 */
export const LINK_HREF_POLICY: Pick<LinkOptions, 'protocols' | 'isAllowedUri'> = {
  // Empty on purpose. Every entry here becomes an allowed scheme; adding one
  // is a security decision and should fail linkOptions.test.ts if it is unsafe.
  protocols: [],
  isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && !usesDeniedScheme(url),
};
