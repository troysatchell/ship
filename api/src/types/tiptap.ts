/**
 * TipTap / ProseMirror JSON node — the wire format for `documents.content`.
 *
 * This is the one structural type this codebase never modeled (finding TS-3):
 * `../utils/yjsConverter.ts` translates between this shape and a Yjs
 * `XmlFragment` in both directions, and it is the only code that does so on
 * the durable document-persistence path (`collaboration/index.ts`'s
 * `persistDocument()`, and `routes/documents.ts`'s content-over-REST reads).
 *
 * Kept API-local on purpose. Promoting this to `shared/` so the frontend
 * consumes the exact same type is a natural next step — see finding TS-5 in
 * `audit/AUDIT_REPORT.md` — but is out of scope for this fix.
 */

/** A value a TipTap/ProseMirror node or mark attribute can hold. */
export type TipTapAttrValue = string | number | boolean | null;

/**
 * A mark applied to a text node, e.g. `{ type: 'bold' }` or
 * `{ type: 'link', attrs: { href, target } }`.
 */
export interface TipTapMark {
  type: string;
  attrs?: Record<string, TipTapAttrValue>;
}

/**
 * A single node in the TipTap/ProseMirror document tree. Recursive: block and
 * inline elements nest further nodes via `content`; leaf text nodes carry
 * `text` and optional `marks` instead of `content`.
 */
export interface TipTapNode {
  type: string;
  attrs?: Record<string, TipTapAttrValue>;
  content?: TipTapNode[];
  marks?: TipTapMark[];
  text?: string;
}

/** The document root TipTap always produces: `{ type: 'doc', content: [...] }`. */
export interface TipTapDoc extends TipTapNode {
  type: 'doc';
  content: TipTapNode[];
}
