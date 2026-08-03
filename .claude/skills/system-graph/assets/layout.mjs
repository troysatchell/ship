#!/usr/bin/env node
/*
 * layout.mjs — build-time graph layout for system-graph artifacts.
 *
 * Reads an ELK graph JSON on stdin, writes the laid-out graph JSON to stdout.
 * Layout is computed ONCE at build time and baked into the artifact, so the
 * artifact ships zero runtime graph libraries: it is a plain SVG + ~10kB of
 * vanilla JS. That is what makes it self-contained, instantly renderable, and
 * deterministic (same model -> same geometry -> reviewable diffs).
 *
 * Requires elkjs. build.py installs it on demand:
 *     npm install --no-save --prefix <cachedir> elkjs@0.9.3
 */
import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    process.stderr.write('layout.mjs: bad JSON on stdin: ' + e.message + '\n');
    process.exit(2);
  }
  const out = {};
  for (const [viewId, graph] of Object.entries(payload)) {
    try {
      out[viewId] = await elk.layout(graph);
    } catch (e) {
      process.stderr.write(`layout.mjs: view "${viewId}" failed: ${e.message}\n`);
      process.exit(3);
    }
  }
  process.stdout.write(JSON.stringify(out));
});
