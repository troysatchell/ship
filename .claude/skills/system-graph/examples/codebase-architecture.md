# got — HTTP client architecture
25 modules, extracted with dependency-cruiser · sindresorhus/got @ main · profile: code

25 modules · 41 connections · 0 cycles · 9 open questions

## Modules

### as-promise
- **as-promise** [module] — source/as-promise/index.ts · fan-in 1, fan-out 5, instability 0.83 · 328 loc
  source: source/as-promise/index.ts
- **types** [module] — source/as-promise/types.ts · fan-in 0, fan-out 0 · 30 loc
  source: source/as-promise/types.ts

### core
- **errors** [module] — source/core/errors.ts · fan-in 4, fan-out 1, instability 0.2 · 192 loc
  The error taxonomy. Every failure mode the library can produce is a class in this file, which is why so much of the codebase points at it.
  source: source/core/errors.ts
- **core** [module] — source/core/index.ts — the Request engine · fan-in 3, fan-out 13, instability 0.81 · 2658 loc
  The Request class: the engine every other path funnels through. 2,658 lines and 13 outbound dependencies — it is the single place where streams, retries, timeouts, redirects and events are coordinated.
  source: source/core/index.ts
- **calculate-retry-delay** [module] — source/core/calculate-retry-delay.ts · fan-in 2, fan-out 0, instability 0.0 · 42 loc
  source: source/core/calculate-retry-delay.ts
- **diagnostics-channel** [module] — source/core/diagnostics-channel.ts · fan-in 2, fan-out 0, instability 0.0 · 139 loc
  source: source/core/diagnostics-channel.ts
- **options** [datastore] — source/core/options.ts — configuration state · fan-in 4, fan-out 5, instability 0.56 · 3732 loc
  One object holding the entire configuration surface, merged and normalised. Depended on by four modules and depending on five: it is both the shared vocabulary of the library and its widest coupling point.
  source: source/core/options.ts
- **parse-link-header** [module] — source/core/parse-link-header.ts · fan-in 2, fan-out 0, instability 0.0 · 105 loc
  source: source/core/parse-link-header.ts
- **timed-out** [module] — source/core/timed-out.ts · fan-in 3, fan-out 1, instability 0.25 · 201 loc
  source: source/core/timed-out.ts
- **response** [module] — source/core/response.ts · fan-in 3, fan-out 2, instability 0.4 · 191 loc
  source: source/core/response.ts

### core/utils
- **strip-url-auth** [guard] — source/core/utils/strip-url-auth.ts · fan-in 3, fan-out 0, instability 0.0 · 9 loc
  source: source/core/utils/strip-url-auth.ts
- **unhandle** [module] — source/core/utils/unhandle.ts · fan-in 1, fan-out 0, instability 0.0 · 39 loc
  source: source/core/utils/unhandle.ts
- **dns-cache** [datastore] — source/core/utils/dns-cache.ts · fan-in 1, fan-out 0, instability 0.0 · 727 loc
  source: source/core/utils/dns-cache.ts
- **http2-client** [module] — source/core/utils/http2-client.ts · fan-in 1, fan-out 1, instability 0.5 · 1580 loc
  source: source/core/utils/http2-client.ts
- **is-unix-socket-url** [guard] — source/core/utils/is-unix-socket-url.ts · fan-in 2, fan-out 0, instability 0.0 · 27 loc
  source: source/core/utils/is-unix-socket-url.ts
- **get-body-size** [module] — source/core/utils/get-body-size.ts · fan-in 1, fan-out 0, instability 0.0 · 27 loc
  source: source/core/utils/get-body-size.ts
- **is-client-request** [guard] — source/core/utils/is-client-request.ts · fan-in 1, fan-out 0, instability 0.0 · 8 loc
  source: source/core/utils/is-client-request.ts
- **proxy-events** [module] — source/core/utils/proxy-events.ts · fan-in 2, fan-out 0, instability 0.0 · 20 loc
  source: source/core/utils/proxy-events.ts
- **timer** [module] — source/core/utils/timer.ts · fan-in 1, fan-out 1, instability 0.5 · 241 loc
  source: source/core/utils/timer.ts
- **defer-to-connect** [module] — source/core/utils/defer-to-connect.ts · fan-in 1, fan-out 0, instability 0.0 · 44 loc
  source: source/core/utils/defer-to-connect.ts
- **weakable-map** [module] — source/core/utils/weakable-map.ts · fan-in 1, fan-out 0, instability 0.0 · 28 loc
  source: source/core/utils/weakable-map.ts
- **options-to-url** [module] — source/core/utils/options-to-url.ts · fan-in 0, fan-out 0 · 71 loc
  source: source/core/utils/options-to-url.ts

### root
- **create** [orchestrator] — source/create.ts · fan-in 1, fan-out 3, instability 0.75 · 412 loc
  The factory that wires defaults, handlers and instances together. This is where extension happens — got.extend() lands here.
  source: source/create.ts
- **source** [api] — source/index.ts — public exports · fan-in 0, fan-out 8, instability 1.0 · 27 loc
  The public export surface. Everything a consumer of got can reach is named here; anything not re-exported is private by construction.
  source: source/index.ts
- **types** [module] — source/types.ts · fan-in 0, fan-out 0 · 342 loc
  source: source/types.ts

## Connections
- as-promise → errors
- as-promise → core
- as-promise → options
- as-promise → response
- as-promise → proxy-events
- errors → strip-url-auth
- core → calculate-retry-delay
- core → diagnostics-channel
- core → errors
- core → options
- core → response
- core → timed-out
- core → get-body-size
- core → is-client-request
- core → is-unix-socket-url
- core → proxy-events
- core → strip-url-auth
- core → timer
- core → weakable-map
- options → parse-link-header
- options → timed-out
- options → dns-cache
- options → http2-client
- options → is-unix-socket-url
- timed-out → unhandle
- http2-client → timed-out
- response → errors
- response → strip-url-auth
- timer → defer-to-connect
- create → as-promise
- create → core
- create → options
- source → calculate-retry-delay
- source → diagnostics-channel
- source → errors
- source → core
- source → options
- source → parse-link-header
- source → response
- source → create
- MISSING LINK (modelled absence): errors → source (gap, errors not re-exported here?)
  Confirm the error classes consumers need to catch are all reachable from the public surface. If a thrown type is not exported, callers cannot instanceof it.

## Open questions (analyzer findings)
- [high] **“options” is coupled in both directions**
  4 modules depend on it and it depends on 5 others. It is simultaneously hard to change (many dependents) and hard to keep stable (many dependencies). This is the classic shape of a module that has absorbed responsibilities that belong elsewhere — split it along the two directions of coupling.
- [high] **“core” is 25× the median module size**
  2658 lines against a median of 105. Size on its own is not a defect, but a module this far off the distribution is almost always several modules that were never separated — and it is the hardest place in the codebase to change safely, review, or test in isolation.
- [high] **“options” is 35× the median module size**
  3732 lines against a median of 105. Size on its own is not a defect, but a module this far off the distribution is almost always several modules that were never separated — and it is the hardest place in the codebase to change safely, review, or test in isolation.
- [high] **“http2-client” is 15× the median module size**
  1580 lines against a median of 105. Size on its own is not a defect, but a module this far off the distribution is almost always several modules that were never separated — and it is the hardest place in the codebase to change safely, review, or test in isolation.
- [medium] **Node core and third-party dependencies are not drawn**
  dependency-cruiser was run on source/ only, so node:http, node:stream, cacheable-lookup and form-data-encoder are invisible here. The diagram therefore shows internal coupling honestly and external coupling not at all. Add them as kind: vendor nodes before using this to reason about upgrade risk.
- [medium] **“core” reaches into 13 other modules**
  Fan-out of 13, instability 0.81. This module knows about most of the codebase, so almost any change elsewhere can break it, and reading it requires holding the whole system in your head. Look for a seam: usually a hub like this is one coordinator plus several collaborators that could be injected instead of imported.
- [medium] **“source” reaches into 8 other modules**
  Fan-out of 8, instability 1.0. This module knows about most of the codebase, so almost any change elsewhere can break it, and reading it requires holding the whole system in your head. Look for a seam: usually a hub like this is one coordinator plus several collaborators that could be injected instead of imported.
- [medium] **“dns-cache” is 6× the median module size**
  727 lines against a median of 105. Size on its own is not a defect, but a module this far off the distribution is almost always several modules that were never separated — and it is the hardest place in the codebase to change safely, review, or test in isolation.
- [medium] **3 module(s) have no inbound dependency**
  Nothing imports types, options-to-url, types. Each is either an entry point that should be marked as one, or dead code. Confirm with a reachability tool (knip, vulture, `go vet`) before deleting.
