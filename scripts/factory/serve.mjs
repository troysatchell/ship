#!/usr/bin/env node
/**
 * serve.mjs — the operational dashboard. Free to refresh, no agent in the loop.
 *
 *   node scripts/factory/serve.mjs          # http://localhost:7373
 *   node scripts/factory/serve.mjs --port 8080
 *
 * WHY THIS EXISTS ALONGSIDE THE PUBLISHED ARTIFACT:
 *
 *   The Artifact is republished by *an agent calling a tool*. A shell script
 *   cannot update it. So refreshing it costs a tool call and tokens, and only
 *   happens when an agent is mid-turn — which makes it a poor choice for the
 *   thing you stare at while a factory run is going.
 *
 *   This server rebuilds the board on every request from live state. Watching it
 *   costs nothing and needs no agent. Use this to OPERATE the factory; use the
 *   Artifact to SHARE a milestone.
 */

import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const portArg = process.argv.indexOf('--port')
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 7373

const render = () =>
  execFileSync(process.execPath, [join(here, 'board.mjs'), '--live'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    cwd: process.cwd(),
  })

const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end() }
  try {
    const html = render()
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // Always re-render: a cached control panel is a lying control panel.
      'cache-control': 'no-store',
    })
    res.end(html)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`board.mjs failed:\n\n${err.stderr?.toString() || err.message}`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Ship Factory board → http://localhost:${PORT}`)
  console.log(`  Rebuilt from live state on every request. Ctrl-C to stop.\n`)
})
