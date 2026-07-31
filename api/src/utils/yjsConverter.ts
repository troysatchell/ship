/**
 * Yjs ↔ TipTap JSON Conversion Utilities
 *
 * These functions convert between Yjs XmlFragment format (used for real-time collaboration)
 * and TipTap/ProseMirror JSON format (used for REST API and static content).
 */

import * as Y from 'yjs';
import type { TipTapAttrValue, TipTapDoc, TipTapMark, TipTapNode } from '../types/tiptap.js';

// Mark types that should be converted from wrapper elements to text marks
const MARK_TYPES = new Set(['bold', 'italic', 'strike', 'underline', 'code', 'link']);

/**
 * Check if an element is an inline mark (bold, italic, etc.) rather than a block element
 */
function isMarkElement(nodeName: string): boolean {
  return MARK_TYPES.has(nodeName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * One entry of `YXmlText.toDelta()`'s output for a materialized (non-snapshot)
 * text — always an insert op, no `retain`/`delete`, since this converter only
 * ever inserts plain string runs into a `Y.XmlText` (see `jsonToYjs` below).
 *
 * Marks surface here as `attributes` regardless of which write path put them
 * there (TRO-296):
 *
 * - This file's own `jsonToYjs`/`jsonToYjsChildren`, via `Y.XmlText.format()`.
 * - The LIVE collaborative editor's Yjs binding
 *   (`y-prosemirror/src/plugins/sync-plugin.js`'s `createTypeFromTextNodes`),
 *   via `Y.XmlText.applyDelta()` with `attributes: marksToAttributes(node.marks, meta)`.
 *   Every ProseMirror mark a real user applies in the live editor (bold,
 *   italic, a link, ...) goes through THIS path, never through `jsonToYjs`.
 *
 * Both write into the same underlying Yjs text-formatting representation, and
 * `YXmlText.toString()` (`yjs/src/types/YXmlText.js:68-100`) serializes that
 * representation as literal pseudo-XML wrapped around the text either way —
 * this converter used to call `.toString()` on every `Y.XmlText` it read, so
 * a mark round-tripped as the literal string `<bold>text</bold>` instead of a
 * `marks` array. Reading `.toDelta()` directly instead decodes the same
 * representation correctly.
 */
interface TextDeltaOp {
  insert: string;
  attributes: Record<string, unknown> | undefined;
}

/**
 * `YXmlText.toDelta()`'s declared return type is `any` (ambient
 * `yjs/dist/src/types/YText.d.ts`) — narrow it structurally at runtime the
 * same way `typeAttributes()` below narrows `getAttributes()`, rather than
 * trusting it.
 */
function parseTextDelta(rawDelta: unknown): TextDeltaOp[] {
  if (!Array.isArray(rawDelta)) return [];
  const ops: TextDeltaOp[] = [];
  for (const entry of rawDelta) {
    if (!isRecord(entry) || typeof entry.insert !== 'string') continue;
    ops.push({
      insert: entry.insert,
      attributes: isRecord(entry.attributes) ? entry.attributes : undefined,
    });
  }
  return ops;
}

function isTipTapAttrValue(value: unknown): value is TipTapAttrValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * A mark applied via `.format()`/`.applyDelta()` carries its attrs (if any)
 * as the delta attribute's value directly — an empty object for a plain mark
 * like bold, a real attrs object (`{ href, target }`) for a link.
 *
 * y-prosemirror additionally suffixes the attribute key with a
 * `--<8-char-hash>` for a mark type configured to allow overlapping instances
 * of itself (`isOverlapping` in `marksToAttributes`,
 * y-prosemirror/src/plugins/sync-plugin.js). None of `MARK_TYPES` here do
 * that by default — ProseMirror marks exclude other instances of the same
 * type unless configured otherwise — but stripping the suffix defensively
 * costs nothing and keeps a mark type from silently vanishing if that ever
 * changes upstream. Mirrors y-prosemirror's own `yattr2markname`.
 */
const OVERLAPPING_MARK_HASH_SUFFIX = /--[a-zA-Z0-9+/=]{8}$/;

function marksFromDeltaAttributes(attributes: Record<string, unknown> | undefined): TipTapMark[] {
  if (!attributes) return [];
  const marks: TipTapMark[] = [];
  for (const [rawKey, value] of Object.entries(attributes)) {
    const type = rawKey.replace(OVERLAPPING_MARK_HASH_SUFFIX, '');
    if (!isMarkElement(type)) continue; // only decode marks this converter knows about
    if (isRecord(value)) {
      const attrs: Record<string, TipTapAttrValue> = {};
      for (const [attrKey, attrValue] of Object.entries(value)) {
        if (isTipTapAttrValue(attrValue)) attrs[attrKey] = attrValue;
      }
      marks.push(Object.keys(attrs).length > 0 ? { type, attrs } : { type });
    } else {
      marks.push({ type });
    }
  }
  return marks;
}

/**
 * Convert one `Y.XmlText`'s content into TipTap text node(s), decoding
 * `.format()`/`.applyDelta()` marks back into a `marks` array (TRO-296)
 * instead of calling `.toString()` and keeping its literal pseudo-XML.
 * `inheritedMarks` carries marks from an ancestor `<bold>`-style wrapper
 * element — the representation `extractTextWithMarks` below also still
 * reads, for whatever may have written that shape.
 */
function xmlTextToNodes(text: Y.XmlText, inheritedMarks: TipTapMark[] = []): TipTapNode[] {
  const nodes: TipTapNode[] = [];
  for (const op of parseTextDelta(text.toDelta())) {
    if (!op.insert) continue;
    const marks = [...inheritedMarks, ...marksFromDeltaAttributes(op.attributes)];
    nodes.push(marks.length > 0 ? { type: 'text', text: op.insert, marks } : { type: 'text', text: op.insert });
  }
  return nodes;
}

/**
 * Yjs's `getAttributes()` on an unparameterized `XmlElement` returns
 * `string`-valued attributes only (its declared default). This codebase also
 * writes a `level` heading attribute back with its real `number` type (see
 * `jsonToYjs` below), so a stored value can come back either way — convert
 * the string form back to a number, and pass everything else through as-is.
 * `value === undefined` cannot occur in practice (an attribute key is only
 * present when it has a real value) but is skipped explicitly rather than
 * assumed away.
 */
function typeAttributes(attrs: { [key: string]: string | undefined }): Record<string, TipTapAttrValue> | undefined {
  if (Object.keys(attrs).length === 0) return undefined;

  const typedAttrs: Record<string, TipTapAttrValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key === 'level' && typeof value === 'string') {
      typedAttrs[key] = parseInt(value, 10);
    } else {
      typedAttrs[key] = value;
    }
  }
  return typedAttrs;
}

/**
 * Yjs's ambient `XmlElement.setAttribute` (unparameterized, like every element
 * this file creates) pins attribute values to `string`. This codebase has
 * always stored some attributes using their real JS type instead — a numeric
 * heading `level` (`typeAttributes()` above undoes exactly that on the way
 * back out) — and the runtime attribute map neither knows nor enforces
 * `string`; it stores whatever it is given. Isolating that one, real gap
 * between the library's declared type and its actual behavior here, rather
 * than repeating the cast at every call site, documents it once.
 */
function setAttributeValue(element: Y.XmlElement, key: string, value: TipTapAttrValue): void {
  element.setAttribute(key, value as string);
}

/**
 * Extract text content and marks from a mark element (e.g., <bold>text</bold>)
 * Returns array of text nodes with marks applied
 */
function extractTextWithMarks(element: Y.XmlElement, inheritedMarks: TipTapMark[] = []): TipTapNode[] {
  const nodeName = element.nodeName;
  const { href, target } = element.getAttributes();

  // Build mark for this element
  const mark: TipTapMark = { type: nodeName };
  if (nodeName === 'link' && href) {
    mark.attrs = { href, target: target || '_blank' };
  }

  const currentMarks = [...inheritedMarks, mark];
  const result: TipTapNode[] = [];

  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      result.push(...xmlTextToNodes(child, currentMarks));
    } else if (child instanceof Y.XmlElement) {
      if (isMarkElement(child.nodeName)) {
        // Nested mark (e.g., <bold><italic>text</italic></bold>)
        result.push(...extractTextWithMarks(child, currentMarks));
      } else {
        // Block element inside mark - shouldn't happen but handle gracefully
        result.push(...yjsElementToJson(child));
      }
    }
  }

  return result;
}

/**
 * Convert Yjs XmlFragment to TipTap JSON
 * This is used when reading documents that were edited via the collaborative editor
 */
export function yjsToJson(fragment: Y.XmlFragment): TipTapDoc {
  const content: TipTapNode[] = [];

  for (let i = 0; i < fragment.length; i++) {
    const item = fragment.get(i);
    if (item instanceof Y.XmlText) {
      // Handle text nodes, decoding any `.format()`/`.applyDelta()` marks
      // back into a TipTap `marks` array (TRO-296) instead of taking the
      // literal pseudo-XML `.toString()` would produce.
      content.push(...xmlTextToNodes(item));
    } else if (item instanceof Y.XmlElement) {
      // Check if this is a mark element (bold, italic, etc.)
      if (isMarkElement(item.nodeName)) {
        content.push(...extractTextWithMarks(item));
      } else {
        // Handle block element nodes
        const node: TipTapNode = { type: item.nodeName };

        // Get attributes, converting string attributes to proper types (e.g., level should be number)
        const typedAttrs = typeAttributes(item.getAttributes());
        if (typedAttrs) {
          node.attrs = typedAttrs;
        }

        // Recursively convert children
        if (item.length > 0) {
          const childContent = yjsElementToJson(item);
          if (childContent.length > 0) {
            node.content = childContent;
          }
        }

        content.push(node);
      }
    }
  }

  return { type: 'doc', content };
}

/**
 * Helper to convert element children recursively
 */
function yjsElementToJson(element: Y.XmlElement): TipTapNode[] {
  const content: TipTapNode[] = [];

  for (let i = 0; i < element.length; i++) {
    const item = element.get(i);
    if (item instanceof Y.XmlText) {
      content.push(...xmlTextToNodes(item));
    } else if (item instanceof Y.XmlElement) {
      // Check if this is a mark element (bold, italic, etc.)
      if (isMarkElement(item.nodeName)) {
        content.push(...extractTextWithMarks(item));
      } else {
        const node: TipTapNode = { type: item.nodeName };

        const typedAttrs = typeAttributes(item.getAttributes());
        if (typedAttrs) {
          node.attrs = typedAttrs;
        }

        if (item.length > 0) {
          const childContent = yjsElementToJson(item);
          if (childContent.length > 0) {
            node.content = childContent;
          }
        }

        content.push(node);
      }
    }
  }

  return content;
}

/**
 * Convert TipTap JSON content to Yjs XmlFragment
 * Must be called within a transaction for proper Yjs integration
 */
export function jsonToYjs(doc: Y.Doc, fragment: Y.XmlFragment, content: TipTapNode): void {
  if (!content || !Array.isArray(content.content)) return;
  const nodes = content.content;

  doc.transact(() => {
    for (const node of nodes) {
      if (node.type === 'text') {
        // Text node - create, push to parent first, then modify
        const text = new Y.XmlText();
        fragment.push([text]);
        text.insert(0, node.text || '');
        if (node.marks) {
          const attrs: Record<string, TipTapAttrValue | Record<string, TipTapAttrValue> | true> = {};
          for (const mark of node.marks) {
            attrs[mark.type] = mark.attrs || true;
          }
          text.format(0, text.length, attrs);
        }
      } else {
        // Element node (paragraph, heading, bulletList, listItem, etc.)
        const element = new Y.XmlElement(node.type);
        fragment.push([element]);
        // Set attributes after adding to parent
        if (node.attrs) {
          for (const [key, value] of Object.entries(node.attrs)) {
            setAttributeValue(element, key, value);
          }
        }
        // Recursively add children
        if (node.content) {
          jsonToYjsChildren(doc, element, node.content);
        }
      }
    }
  });
}

/**
 * Helper to add children without wrapping in another transaction
 */
function jsonToYjsChildren(doc: Y.Doc, parent: Y.XmlElement, children: TipTapNode[]): void {
  for (const node of children) {
    if (node.type === 'text') {
      const text = new Y.XmlText();
      parent.push([text]);
      text.insert(0, node.text || '');
      if (node.marks) {
        const attrs: Record<string, TipTapAttrValue | Record<string, TipTapAttrValue> | true> = {};
        for (const mark of node.marks) {
          attrs[mark.type] = mark.attrs || true;
        }
        text.format(0, text.length, attrs);
      }
    } else {
      const element = new Y.XmlElement(node.type);
      parent.push([element]);
      if (node.attrs) {
        for (const [key, value] of Object.entries(node.attrs)) {
          setAttributeValue(element, key, value);
        }
      }
      if (node.content) {
        jsonToYjsChildren(doc, element, node.content);
      }
    }
  }
}

/**
 * Load document content from Yjs binary state
 * Returns TipTap JSON content or null if unable to convert
 */
export function loadContentFromYjsState(yjsState: Buffer): TipTapDoc | null {
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, yjsState);
    const fragment = doc.getXmlFragment('default');
    return yjsToJson(fragment);
  } catch (err) {
    console.error('Failed to load content from Yjs state:', err);
    return null;
  }
}
