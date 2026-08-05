/**
 * TRO-309 (CodeQL js/incomplete-sanitization, swagger.ts:59) — regression
 * coverage for `jsonToYaml`'s quoted-string escaping.
 *
 * A string value gets wrapped in double quotes whenever it contains a
 * newline, a colon, or a `#` (so the emitted YAML stays parseable). The
 * quoting step escaped `"` but never `\`, so a value containing a bare
 * trailing backslash right before the closing quote produced a scalar whose
 * last two characters are `\"` — a YAML *escaped quote*, not the string
 * terminator. Escaping `\` first (turning `\` into `\\`) keeps the
 * following `\"` an unambiguous, correctly escaped literal quote.
 *
 * This file unit-tests the extracted pure function directly — no HTTP
 * request, no Express app — because `jsonToYaml` is exactly the code
 * CodeQL flagged, and `/api/openapi.yaml` does nothing to its output beyond
 * sending it as the response body.
 */
import { describe, it, expect } from 'vitest';
import { jsonToYaml } from './swagger.js';

describe('TRO-309: jsonToYaml backslash escaping', () => {
  it('leaves a plain string (no quoting trigger) untouched', () => {
    expect(jsonToYaml('plain value')).toBe('plain value');
  });

  it('escapes a bare double quote inside a quoted value', () => {
    // ':' triggers quoting.
    expect(jsonToYaml('label: say "hi"')).toBe('"label: say \\"hi\\""');
  });

  it('escapes a backslash so a trailing one cannot swallow the closing quote', () => {
    // ':' triggers quoting. Before the fix this produced `"trailing:\"` —
    // an unterminated YAML double-quoted scalar, because the unescaped
    // backslash turns the intended closing `"` into an escaped-quote
    // character instead of the terminator.
    const result = jsonToYaml('trailing:\\');
    expect(result).toBe('"trailing:\\\\"');
    // Concretely: the string must end with an escaped backslash followed by
    // an unescaped, terminating quote — not a bare backslash-quote pair.
    expect(result.endsWith('\\\\"')).toBe(true);
  });

  it('escapes multiple backslashes and a quote together', () => {
    const result = jsonToYaml('path: C:\\Users\\"name"');
    expect(result).toBe('"path: C:\\\\Users\\\\\\"name\\""');
  });
});
