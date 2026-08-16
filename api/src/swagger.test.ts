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
import { parse } from 'yaml';
import { jsonToYaml, swaggerSpec } from './swagger.js';

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

/**
 * TRO-490 — `jsonToYaml`'s output must parse as valid YAML and round-trip
 * back to the same structure. Two concrete defects observed in
 * `api/openapi.yaml` on main before this fix:
 *
 *  - An empty-object value was emitted as `key:` followed by `{}` on its
 *    own line at column 0 (invalid/ambiguous), because the object branch
 *    always emitted `key:\n` + a recursive call, and `jsonToYaml({})`
 *    returned `{}` with no indentation of its own.
 *  - Array items that are objects came out over-indented, because the
 *    array branch called `jsonToYaml(item, indent + 1)` (already indented
 *    relative to the array) and then ALSO prefixed every continuation line
 *    with an extra `${spaces}  ` — double indentation.
 *
 * A third class (not visible in a spot-check but the same root cause):
 * strings that look like other YAML scalar types (`'true'`, `'123'`, `''`,
 * leading/trailing spaces, strings starting with `*`, `&`, `!`, `[`, `{`,
 * `-`, `?`, `%`, `@`, backtick, quotes) were emitted bare, so a real parser
 * hands back a boolean/number/null instead of the original string.
 */
describe('TRO-490: jsonToYaml output round-trips through a real YAML parser', () => {
  it('full swagger spec round-trips', () => {
    expect(parse(jsonToYaml(swaggerSpec))).toEqual(JSON.parse(JSON.stringify(swaggerSpec)));
  });

  it('empty object values are inline and array-of-object items are indented once', () => {
    const fixture = {
      parameters: {},
      tags: [],
      list: [{ schema: { type: 'string', enum: ['a', 'b'] } }],
    };
    const out = jsonToYaml(fixture);
    expect(parse(out)).toEqual(fixture);
    expect(out).toBe(
      'parameters: {}\ntags: []\nlist:\n  - schema:\n      type: string\n      enum:\n        - a\n        - b'
    );
  });

  it('type-ambiguous scalars stay strings', () => {
    const fixture = {
      a: 'true',
      b: '123',
      c: '',
      d: ' lead',
      e: 'trail ',
      f: 'x: y',
      g: 'multi\nline',
      h: '- dash',
      i: '*star',
      j: 'yes',
      k: 'null',
      '200': 'code',
      '/api/issues/{id}': 'path',
    };
    expect(parse(jsonToYaml(fixture))).toEqual(fixture);
  });
});
