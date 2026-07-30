import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * Syntax-highlighting grammars for the editor's code blocks (BUN-3 / TRO-199).
 *
 * The editor previously used lowlight's `common` bundle, which registers 37
 * grammars — 176.3 kB raw / 64.0 kB gzip, the largest single npm package in
 * the bundle. Among them: arduino, vbnet, objectivec, r, lua, perl and wasm,
 * none of which a project-management wiki writes.
 *
 * This is the curated set. The rule for adding one: it has to be a language
 * someone actually pastes into a Ship document.
 *
 * Degradation for a language that is NOT in this list is graceful, not an
 * error: `@tiptap/extension-code-block-lowlight` checks
 * `lowlight.registered(language)` before calling `lowlight.highlight()`, so an
 * unregistered language renders as plain monospace text. Verified by reading
 * node_modules/@tiptap/extension-code-block-lowlight/dist/index.js (the
 * `languages.includes(language) || registered(language)` guard), and asserted
 * in lowlight.test.ts so a lowlight upgrade cannot turn it into a throw.
 */
export const SUPPORTED_CODE_LANGUAGES = {
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  shell,
  sql,
  typescript,
  xml, // also covers html
  yaml,
} as const;

export const lowlight = createLowlight(SUPPORTED_CODE_LANGUAGES);
