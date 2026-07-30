# CHANGES

Every improvement made to Ship during the ShipShape sprint: what was added, how to run it, and
how to roll it back. Newest first. One entry per ticket; the ticket ID is the join key to Linear,
to `audit/AUDIT_REPORT.md`, and to the branch that carried it.

Assignment rule 8. `scripts/factory/gate.sh` fails any branch that does not add an entry here.

---

## TRO-208 — [TS-3] The Yjs <-> TipTap converter — the persistence path for every document's content — was fully untyped

`api/src/utils/yjsConverter.ts` carried 12 `any` in 245 lines, the highest any-per-line density of
any production file, on the only code path that translates collaborative CRDT state into the
durable `documents.content` column: `collaboration/index.ts:151` (`persistDocument()`, right before
the write) and `routes/documents.ts:456` (content served over REST). `api/src/types/y-protocols.d.ts`
added 7 more `any` on the awareness/sync surface underneath. Every exported signature was untyped —
`yjsToJson(fragment): any`, `jsonToYjs(doc, fragment, content: any)`,
`loadContentFromYjsState(yjsState): any | null` — so a shape regression here would silently corrupt
or drop user-authored content with nothing failing to compile.

**What changed — types only, no behavior change.**

- **`api/src/types/tiptap.ts` (new).** One recursive TipTap/ProseMirror JSON node type —
  `TipTapNode` (`type`, optional `attrs`/`content`/`marks`/`text`), `TipTapMark`, `TipTapDoc`, and the
  `TipTapAttrValue` union (`string | number | boolean | null`) node/mark attributes actually hold.
  Kept API-local by design (see "Not done" below).
- **`yjsConverter.ts`** — all five signatures now use these types instead of `any`:
  `yjsToJson(fragment): TipTapDoc`, `jsonToYjs(doc, fragment, content: TipTapNode): void`,
  `loadContentFromYjsState(yjsState): TipTapDoc | null`, plus the internal
  `extractTextWithMarks`/`yjsElementToJson`. A new `typeAttributes()` helper centralizes the one
  existing `Record<string, unknown>` -> typed-attrs conversion (unchanged logic, just typed); a new
  `setAttributeValue()` helper centralizes the one real, documented gap this fix could not type away:
  Yjs's own ambient `XmlElement.setAttribute` pins attribute values to `string`, but this codebase has
  always written some attributes (a numeric heading `level`) using their real JS type and relies on
  Yjs's runtime not enforcing that — a `value as string` assertion there is the one non-`any` cast in
  the diff, isolated and commented rather than repeated at each of the two call sites it used to
  appear at.
- **`y-protocols.d.ts`** — `any` replaced with `unknown` throughout (transaction origins, awareness
  state records, event callback args), except `Awareness.on`/`off`, which gained a real overload for
  the one event this codebase actually listens for (`AwarenessChange { added, updated, removed }`)
  plus a loose `unknown[]` fallback for anything else — a fully untyped variadic callback would have
  accepted a mistyped `'update'` handler just as silently as a correct one.
- **`collaboration/index.ts`** — two type-only edits, no control-flow change: `isTipTapDocContent`'s
  type predicate now asserts `value is TipTapDoc` instead of an inline `{ type: 'doc'; content:
  unknown[] }`, so its narrowed value satisfies `jsonToYjs`'s new parameter type.
- **`collaboration/__tests__/api-content-preservation.test.ts`** — this pre-existing test file calls
  `yjsToJson`/`loadContentFromYjsState` directly and, once they stopped returning `any`, tripped real
  `noUncheckedIndexedAccess` errors on chained array indexing (`convertedBack.content[0].content[0].text`)
  that `any` had been silently swallowing. Fixed with optional chaining (`?.`) and one narrowing
  `if (!result) throw ...` for the nullable `loadContentFromYjsState` case — no assertion was
  loosened; all 18 cases in the file still pass unchanged.

**Found, not fixed (out of scope for a types-only ticket).** Writing the round-trip regression test
below surfaced a real, pre-existing behavioral quirk: `jsonToYjs`/`jsonToYjsChildren` apply text
marks via Yjs's native `YXmlText.format()`, but `yjsToJson`'s read side only recognizes marks
represented as nested `Y.XmlElement` wrapper tags (e.g. `<bold>...</bold>`), which is how the actual
browser TipTap/y-prosemirror binding represents them — not how `.format()` does. `YXmlText.toString()`
(`node_modules/yjs/src/types/YXmlText.js:68-100`) serializes format-delta attributes back as literal
pseudo-XML baked into the plain-text string, so round-tripping a marked text node through
`jsonToYjs` -> `yjsToJson` produces `{ type: 'text', text: '<bold>bold</bold>' }`, not a `marks` array.
This only fires on the one-time JSON->Yjs migration path for documents created via the API and never
opened in the collaborative editor before their first collaboration-server load
(`collaboration/index.ts`'s `loadDoc()`) — verified present, byte-for-byte identical, on both the
unfixed and fixed code (see measurement below), so it predates this ticket and this fix does not
touch it. Worth a follow-up finding; not attempted here per the ticket's explicit "types-only, no
behavior change" scope.

**Not done.** Promoting `TipTapNode`/`TipTapDoc` to `shared/` so the frontend imports the identical
type is a natural next step but is TS-5's business (the `shared/` contract is a separate, open
finding), not this ticket's.

**Regression test — `api/src/utils/__tests__/yjsConverter.test.ts`** (new, vitest, run by the gate).
Two independent parts, per the ticket:

1. Six `expectTypeOf` assertions (`yjsToJson`/`jsonToYjs`/`loadContentFromYjsState` each `.not.toBeAny()`
   plus `.toEqualTypeOf<...>()`) proving the exported signatures are real types. These are
   compile-time-only — `vitest run` transpiles via esbuild and does not evaluate them, so they pass
   silently either way at runtime; verified red **only** via `tsc --noEmit`, by temporarily restoring
   the pre-fix `yjsConverter.ts`/`y-protocols.d.ts`/`collaboration/index.ts` (backed up first, no
   `git stash`) and re-running `pnpm --filter @ship/api exec tsc --noEmit`. Against the unfixed code
   it fails with real, on-point errors — `TS2349: This expression is not callable` on each
   `.not.toBeAny()`, and `TS2344: Type 'TipTapDoc' does not satisfy the constraint 'never'` on each
   `.toEqualTypeOf<...>()` — not an import error or a typo. Restoring the fix returns `tsc --noEmit`
   to clean.
2. Two runtime round-trip tests: a representative document (heading with a numeric `level` attr,
   a paragraph with bold text and a link mark, a nested 2-item bullet list) through
   `jsonToYjs` -> `yjsToJson`, and a second through a real binary Yjs update via
   `loadContentFromYjsState`. Both pin the exact output observed by running the conversion directly
   (`tsx`, no DB) against both the unfixed and fixed `yjsConverter.ts` and diffing — byte-for-byte
   identical — proving the types change altered nothing at runtime, including the marks quirk noted
   above.

**Measurement** (`~/.claude/skills/type-safety-audit/scripts/count.sh`, the audit's own method —
`explicit_any` pattern `:\s*any\b|<any>|\bany\[\]|Array<any>`, BSD grep, counts matching lines):

| Scope | Before | After |
|---|---|---|
| `api/src/utils/yjsConverter.ts` | 12 | **0** |
| `api/src/types/y-protocols.d.ts` | 7 | **0** |
| `api/` package-wide (`explicit_any`) | 78 | **59** (-19) |

The api-wide before (78) matches `audit/type-safety/baseline.json`'s tracked `perPackage.api.anyTotal`
exactly; the -19 delta is precisely the two files' combined reduction, confirmed by isolated
before/after counts on every other file this diff touches (`collaboration/index.ts` and
`api-content-preservation.test.ts` are unchanged on every tracked metric — `explicit_any`,
`as_assertions`, `as_any`, `non_null_assertions` — before vs after). The regex undercounts by its own
documented blind spot (`Record<string, any>` doesn't match `:\s*any\b|<any>`, since `any` isn't
preceded directly by `:`): two such sites in each of `yjsConverter.ts` and `y-protocols.d.ts` were
fixed too and are real reductions the tracked number doesn't reflect.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api exec tsc --noEmit
pnpm --filter @ship/api exec vitest run \
  src/utils/__tests__/yjsConverter.test.ts \
  src/collaboration/__tests__/api-content-preservation.test.ts
```

**Rollback.** `git checkout main -- api/src/utils/yjsConverter.ts api/src/types/y-protocols.d.ts
api/src/collaboration/index.ts api/src/collaboration/__tests__/api-content-preservation.test.ts &&
git rm api/src/types/tiptap.ts api/src/utils/__tests__/yjsConverter.test.ts` and drop this entry. No
schema, route, or runtime-behavior change accompanies this fix, so rollback is type-signature-only.

---

## TRO-206 (TS-1) — `web/tsconfig.json` now extends the root config; 156 latent type errors fixed

`web/tsconfig.json` re-declared `strict: true` standalone instead of extending `../tsconfig.json`,
so it silently ran without the root's `noUncheckedIndexedAccess`, `noImplicitReturns`, and
`noFallthroughCasesInSwitch` — the only two packages that extend the root (`api`, `shared`) had
them; `web` did not. `research/configs/web/tsconfig.json` (a reference copy in the repo) already
`extends: "../tsconfig.json"`, confirming this was drift, not an intentional divergence.

**Ticket hypothesis vs. observed.** The audit (measured at commit `076a183`) recorded 102 errors
under the restored flags. Reproducing the identical command
(`cd web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess
--noImplicitReturns --noFallthroughCasesInSwitch`) on this branch's base — `main` had gained ~30
merged tickets since the audit, adding new files (`lib/contrast.ts`, `lib/contrast.test.ts`,
`pages/MyWeekPage.contrast.test.tsx` from TRO-217, plus other unrelated changes) — produced **156**
errors, not 102: 63 TS2532, 41 TS18048, 26 TS2345, 17 TS2322, 8 TS7030, 1 TS18047, across 29 files.
The fix direction held; the count was stale. All 156 are fixed, not just the original 102.

**What changed.**

- `web/tsconfig.json` — added `"extends": "../tsconfig.json"`; kept web's `target`/`lib`/`module`/
  `moduleResolution`/`jsx`/`noEmit`/`baseUrl`/`paths` overrides (all of which differ from or add to
  the root, e.g. `module: "ESNext"` + `moduleResolution: "bundler"` vs. the root's `NodeNext`, and
  `lib` adding `DOM`/`DOM.Iterable`). Dropped the overrides that were byte-identical to the root
  (`strict`, `skipLibCheck`, `esModuleInterop`, `allowSyntheticDefaultImports`,
  `forceConsistentCasingInFileNames`, `isolatedModules`) since inheriting them is the whole point.
- `web/tailwind.config.d.ts` — the hand-written ambient type for `tailwind.config.js` typed
  `colors` as a bare `Record<string, string>`, so every dot-accessed token (`palette.background`,
  `palette.muted`, ...) came back `string | undefined` under the restored flag. Gave the six tokens
  actually dot-accessed by `contrast.ts`/`contrast.test.ts`/`MyWeekPage.contrast.test.tsx` explicit
  (non-optional) properties, kept a `[key: string]: string` index signature so dynamic lookups
  (`palette[name]`) stay honestly optional.
- 28 source files fixed with genuine narrowing — destructure-then-check, explicit `undefined`
  guards, or an `?? null`/`?? ''` fallback at the point a nullable value crosses into a non-nullable
  slot. No `!`, `as any`, `as unknown as`, or `: any` anywhere in the diff (`node
  scripts/factory/review-patterns.mjs` — G7b — reports clean). Densest: `CommandPalette.tsx` (13),
  `hooks/useSelection.ts` (12), `editor/CommentDisplay.tsx` (12), `editor/AIScoringDisplay.tsx` (12),
  `lib/cn.ts` (12).
- `pages/ReviewsPage.tsx` — the one fix that is more than type-satisfying. Three optimistic-update
  handlers (`approvePlan`, `requestChanges`, `rateRetro`) did
  `updated.reviews[personId][weekNumber] = { ...updated.reviews[personId][weekNumber], patch }`.
  Spreading `undefined` is legal JS and this type-checked before the fix, but for a person/week
  pair with no prior review row it silently produced a `ReviewCell` missing every field except the
  one just patched (`hasPlan`/`hasRetro`/`sprintId`/`planDocId`/`retroDocId` all `undefined` instead
  of their contract). Extracted `emptyReviewCell`/`mergeReviewCellPatch` (both exported) so all
  three handlers merge over a real default instead of a possibly-missing lookup.
  **Reachability, checked rather than assumed:** every UI path that can call these three handlers
  (`ReviewsPage.tsx:919-935`, `:1115`) is gated on `cell.hasPlan`/`cell.hasRetro` already being
  `true`, which requires an already-fetched cell — so this specific corruption was not reachable
  through today's UI. It is a genuine type-safety fix against a real invariant gap, not a
  demonstrated production crash; recorded as such rather than oversold.

**What did NOT change.** No product behavior. `pnpm --filter @ship/web test` is 37 files / 366
tests green before and after (quarantine is already empty per TEST-1); the fixes are narrowing,
not behavior changes, with the one exception above, which changes nothing observable given the
current gating.

**How to run it.**

```bash
source .factory-env
# Reproduce the flag-restoration count (should be 0 now that tsconfig extends root):
cd web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit \
  --noUncheckedIndexedAccess --noImplicitReturns --noFallthroughCasesInSwitch
# Or just the normal check, since the flags are now inherited permanently:
pnpm --filter @ship/web type-check
# Regression test for the ReviewsPage fix:
pnpm --filter @ship/web exec vitest run src/pages/ReviewsPage.reviewCellMerge.test.ts
```

**Rollback.** Revert the commits on `fix/ts-1-web-tsconfig`. Reverting just
`web/tsconfig.json`'s `extends` line restores the pre-fix (silently non-strict) behavior without
touching the 29 narrowed files, which remain correct either way since the narrowing is a strict
superset of the original logic. `emptyReviewCell`/`mergeReviewCellPatch` can be reverted
independently by inlining the old spread in the three `ReviewsPage.tsx` handlers, which restores
the (unreached, per above) invariant gap.

---

## TRO-286 (TEST-14) — no e2e test can pass without executing an assertion any more

TEST-2 (TRO-224) fixed the 8 vacuous tests that gave false *security* assurance and deliberately
stopped, reporting the boundary. This finishes the job and clears two adjacent defects it surfaced.

**Part 1 — the remaining conditional-only tests: 62 → 0.**

Measured with the repo's own detector, `audit/test-quality/runs/vacuous.mjs`, which finds tests
whose every `expect()` sits inside a conditional branch — i.e. tests that pass with zero assertions
executed. On `main` (`c4e92c2`) it reports `testsWithOnlyConditionalExpects: 62`. On this branch it
reports **0**, across the same 870 scanned test blocks.

Every `if (await x.isVisible()) { …expects… }` became an assertion carrying an actionable message,
per the pattern already in `bulk-selection.spec.ts:793`. Converted tests also record *why* the
precondition holds, so the next reader does not re-derive it — seed data creates sprints from
`currentSprintNumber-2` through `+2` (`e2e/fixtures/isolated-env.ts`), so completed sprints always
exist; `cleanupExtraSprints` in `beforeEach` guarantees an empty future week window.

By file: `program-mode-week-ux.spec.ts` (33), `accessibility-remediation.spec.ts` (6),
`context-menus.spec.ts` (6), `features-real.spec.ts` (5), `performance.spec.ts` (2),
`admin-workspace-members.spec.ts` (2), `ai-analysis-api.spec.ts` (1), plus 7 more not named in the
ticket's table that the detector caught.

Two of these were more than a mechanical conversion. `admin-workspace-members.spec.ts` needed the
fixture work the ticket flagged as risky — `isolated-env.ts` now seeds a second workspace and an
unattached user — and the workspace-switcher and admin-dashboard specs were checked for fallout.
`features-real.spec.ts` turned out to be hiding a **real file-chooser race** behind its guard, which
is exactly the failure mode a silently-passing test conceals.

**Part 2 — a user was being told the wrong rate limit.** `api/src/services/ai-analysis.ts` enforces
`RATE_LIMIT = 120`/hour while `api/src/routes/ai.ts` told the user "Max 10 analysis requests per
hour" — off by 12×. Rather than pick a number, the message is now derived from the constant
(`RATE_LIMIT_MESSAGE`), so the two cannot drift apart again, and `api/src/routes/ai.test.ts` (new)
asserts the 429 body reports the enforced limit.

The e2e test that provoked this is marked `test.fixme()` **with a written reason** rather than left
lying. Asserting the real limit needs either 121 requests — 120 of which attempt Bedrock, blowing
the 60s timeout — or an injectable limit, which is a production seam added solely to enable a test.
That is a maintainer's call, not the factory's, and is left open deliberately.

**Part 3 — `.husky/pre-commit` is now `100755` in the index**, where it was `100644`. It *did* still
run, because `core.hooksPath` is `.husky/_` and husky v9's wrapper **sources** the hook rather than
exec'ing it — but that made the mode a latent trap: if the wrapper ever exec'd instead, every
pre-commit check would stop running silently, including the compliance scan.

The ticket carried an unreproduced report that hooks do not fire in a linked worktree. **That is
now disproved**: committing from `Ship-wt-tro_286` (a linked worktree) fired `check-empty-tests.sh`
and `check-api-coverage.sh` and printed their output, as did every commit from the main checkout
throughout the run. Hooks fire in both.

Unrelated but worth stating plainly: `comply` is not installed in this environment, so the secrets
scan warns and passes. **A successful commit is not evidence that scan ran.**

**Part 4 — CodeRabbit review triage on PR #40.** 22 line comments, all real defects in code this PR
touched, none out of scope — every finding was either fixed here or dismissed with a written reason
in the ledger (`audit/factory/review-findings.jsonl`), never silently dropped.

Six were Majors that reintroduced the exact defect class this ticket exists to fix: two fixed
`waitForTimeout` sleeps standing in for synchronization (`admin-workspace-members.spec.ts`,
`program-mode-week-ux.spec.ts`, plus siblings in `issue-display-id.spec.ts` and
`status-colors-accessibility.spec.ts`), the swallowed-failure pattern
`isVisible().catch(() => false)` in an availability-indicator check, a `dashCount === rowCount`
comparison that could pass while filtering nothing correctly (`td` filtered by `—` also matches
assignee/estimate/due-date cells), a near-tautological "highlight" check that matched every card in
the timeline regardless of active state, and non-deterministic fixture restoration in the carol/Test
Space cleanup (`isVisible().catch(() => false)` could silently skip removing her, leaving the next
test in the worker to find her already attached).

Fixing finding 18 (point-in-time `rows.count()` preconditions) surfaced three tests in
`program-mode-week-ux.spec.ts` — "issue row has quick menu (⋮) button" and its two siblings — that
assert a per-row hover-revealed actions button. Traced the full render path
(`IssuesList.tsx` → `IssueRowContent` → `SelectableList.tsx`): no such button exists in list view,
only a right-click context menu and the bulk "Move to Week" toolbar action already covered
elsewhere. TRO-286 Part 1 had already tightened these from "passes whether the feature exists or
not" to a real assertion, which would now fail hard, not vacuously — same shape as the
team-directory quick-menu gap already `test.fixme()`'d in `context-menus.spec.ts`. Marked
`test.fixme()` with the same reasoning rather than left to fail.

One finding was dismissed rather than fixed: WCAG 3.3.3 recovery guidance on the login-error test.
The message is exactly `"Invalid email or password"` (`api/src/routes/auth.ts`), a deliberate
security choice, and `Login.tsx` has no recovery link at all — tightening the assertion would only
ever fail without a UI change, which is a product accessibility gap, not a test bug. Filed as a
follow-up rather than fixed here.

One derived claim was checked and found not to transfer: CodeRabbit's suggested fix for the fixed
sleeps in `program-mode-week-ux.spec.ts` was `page.waitForResponse(...)` on `/api/issues`. Traced
`IssuesList.tsx:569-570` — the sprint filter dropdown filters already-fetched issues client-side; no
new request fires when it changes. Used a retrying DOM assertion instead, which is what the
mechanism actually calls for.

**How to run it.**

```bash
node audit/test-quality/runs/vacuous.mjs        # expect testsWithOnlyConditionalExpects: 0
git ls-files -s .husky/pre-commit               # expect mode 100755
pnpm --filter @ship/api test src/routes/ai.test.ts
```

The Playwright specs themselves need a live app — use `/e2e-test-runner`, never `pnpm test:e2e`
directly, which produces enough output to crash the session.

**Roll back.** `git revert` this merge commit. The conditional guards return (and with them the 62
silently-passing tests), the 429 message goes back to quoting 10/hour against 120/hour enforcement,
and `.husky/pre-commit` reverts to mode `100644`. No schema, API surface, or product behaviour is
touched by any of it — the only production change is the text of one error message.

---

## TRO-246 (rule 5) — CI builds the image once and pushes it by SHA; Render still rebuilds it a second time (switch prepared, not executed)

TRO-242 made the root `Dockerfile` buildable from a clean checkout (multi-stage: builds
`shared`→`api`→`web` inside the image, instead of requiring pre-built `dist/` in the build context).
That closed the "build on a laptop" problem but not the "build once" one: CI verified the source, and
then Render separately built the *same* Dockerfile itself, on its own infrastructure, at its own
time — two independent builds of the same commit, never proven to be the same artifact.

**What changed.**

- `.github/workflows/ci.yml` gains a `build-image` job that builds the root `Dockerfile` with
  `docker/build-push-action` and pushes to `ghcr.io/troysatchell/ship`, authenticated with the
  workflow's own `GITHUB_TOKEN` (job-scoped `permissions: packages: write`). `needs: verify`, so it
  never runs on code that failed typecheck/build/the test-regression check.
  - Tags: the full git SHA (immutable — the identity a rollback promotes/demotes by) and a moving
    `main` tag.
  - Pushes only on an actual push to `main` (`SHOULD_PUSH` gate). Every pull request still **builds**
    (unauthenticated, no push) — this proves the Dockerfile stays buildable from whatever the PR
    changed, without ever needing registry credentials (which a fork PR's `GITHUB_TOKEN` doesn't have
    write scope for anyway).
  - Third-party actions (`docker/setup-buildx-action`, `docker/login-action`,
    `docker/build-push-action`) are pinned to full commit SHAs, matching this file's existing
    convention for non-`actions/*` steps.
- `docs/deployment-artifact-lifecycle.md` (new): what's built, where it's stored, the tagging
  scheme, and — the actual "promote" and "roll back to a previous SHA" procedures — plus a
  ready-to-run Render switch runbook.
- `docs/application-architecture.md`: one-line pointer from the (stale, AWS-only) Deployment section
  to the new doc and to `memory-bank/techContext.md`'s Render facts, so the two don't silently
  diverge further. The AWS-only diagram/infra list itself is untouched — out of scope here.

**What did NOT change — the Render switch itself is prepared, not executed.** Changing the live
`ship` service (`srv-d9kf2t942hec73aofrt0`, currently `runtime: docker` building the Dockerfile on
Render's own infrastructure) from a repo-build to an image-deploy is an outward-facing, largely
irreversible action against the graded submission URL (`https://ship-rr6m.onrender.com`) —
escalation gate 2. No Render API call was made, no credential was read or moved, and the repo-root
`.env` was not touched. `docs/deployment-artifact-lifecycle.md`'s runbook is the exact procedure for
whoever runs it, including the parts that could not be independently verified from here (Render's
`image` field on the Update Service API is documented to exist but its full sub-schema was not
reachable this session — flagged explicitly, with a documented dashboard fallback that needs no
schema guessing).

**Regression test: honestly, none applies.** This ticket's deliverable is a CI workflow change plus
documentation — there is no application code path for a vitest regression test to exercise, and
`scripts/factory/gate.sh`'s regression-test check (G6, which counts added `it(`/`test(` cases in
`*.test.ts`/`*.test.tsx`/`*.spec.ts`) is expected to fail honestly rather than be satisfied by a
manufactured, vacuous test. YAML validity of the workflow file was checked instead — see PR body for
the exact method (the repo's own `js-yaml` dependency, since `actionlint` is not installed here).

**How to run it.**

```bash
# Local build proof — same Dockerfile path CI runs, from a clean tree:
docker build -t ship:tro-246-local -f Dockerfile .
docker images ship:tro-246-local   # 482 MB, observed this session

# YAML-validate the workflow (repo's own transitive js-yaml dep, no actionlint installed):
node -e "require('./node_modules/.pnpm/js-yaml@4.1.1/node_modules/js-yaml') \
  .load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('ok')"

# The real test of the CI behavior itself is derived, not run here — the first push to `main`
# after this merges is the live test of build-image actually pushing to GHCR.
```

**How to roll it back.**

- CI job: revert the `build-image` addition to `.github/workflows/ci.yml`; `verify`/`inventory` are
  untouched and keep running exactly as before.
- Docs: delete `docs/deployment-artifact-lifecycle.md` and revert the one-line pointer in
  `docs/application-architecture.md`.
- Nothing to roll back on Render — the switch was never executed.

---

## TRO-216 — [A11Y-2] `aria-expanded` on a plain `<div>` in the editor wrapper

**What was broken.** axe reported a Critical `aria-allowed-attr` violation on `.tiptap-wrapper >
div`: `<div style="position: relative;" aria-expanded="false">` — a plain `<div>` with no role,
carrying an ARIA attribute that role does not support. It only appeared in the "editor focused"
state, which is why the repo's own axe specs (which scan static viewports) never caught it.

**The mechanism — found, not guessed.** `.tiptap-wrapper > div` is the `<div>` `@tiptap/react`'s
`<EditorContent>` renders to host the ProseMirror view; once mounted it is also
`editor.options.element`. The comment `<BubbleMenu>` in `Editor.tsx` (~line 1008) is implemented by
`@tiptap/extension-bubble-menu`'s `BubbleMenuPlugin`, whose `BubbleMenuView.createTooltip()`
(2.27.2, `dist/index.js:122-136`) calls `tippy(editorElement, { interactive: true, ... })` the
first time the selection or doc changes after mount — i.e. `editorElement` **is**
`editor.options.element`, the same div. tippy's default `aria: { expanded: 'auto' }` combined with
`interactive: true` makes it call `referenceEl.setAttribute('aria-expanded', ...)` on that div
unconditionally (`tippy.js`'s `handleAriaExpandedAttribute`, `dist/tippy.cjs.js:801-813`), whether
or not the bubble menu is ever shown. The `position: relative;` inline style on the same node is a
second, independent library write to the identical element — `DragHandleExtension`
(`web/src/components/editor/DragHandle.tsx:206`) sets it on `view.dom.parentElement`, which is the
same wrapper — confirming both clues in the axe `html` string point at one node for two unrelated
reasons.

The div itself does not expand or collapse anything; it is only tippy's positioning anchor for the
floating "Comment" button. This is subtraction, not a role fix — there was never a widget here.

**What changed.** `web/src/components/Editor.tsx`: the comment `<BubbleMenu>`'s `tippyOptions` is
now a named export, `commentBubbleMenuTippyOptions`, with `aria: { expanded: false }` added. That
tells tippy never to manage `aria-expanded` on its reference element for this instance. No
behavioural change: the bubble menu still shows and hides identically on selection; only the
ARIA bookkeeping attribute on the unrelated wrapper div is suppressed. The element does not become
focusable and no keyboard behaviour changes, so this does not require the escalation path for a
user-perceivable interaction change.

**Evidence.** Both ends measured on this branch, same conditions: `http://localhost:5906`
(worktree ports), Chrome for Testing (Playwright 1217 build) headless, 1440×900, axe-core 4.11
(`@axe-core/playwright`), authenticated as `dev@ship.local` via a fresh `session_id`, wiki document
`7b254b07-e251-46bc-8e14-d4e10b76dd2b` ("Welcome to Ship"), editor focused by clicking into
`.ProseMirror`. Each measurement restarted the Vite dev server first and the served module content
was diffed directly (`curl .../src/components/Editor.tsx`) to confirm which code path was live
before scanning — Vite's dev transform cache does not always invalidate on save alone.

| Measurement — "document editor focused" | Before | After |
|---|---|---|
| axe `aria-allowed-attr` | **Critical, 1 node** (`.tiptap-wrapper > div`) | **absent** |
| axe all severities | **C1** S0 M0 m0 | **C0** S0 M0 m0 |

**Regression test.** `web/src/components/Editor.bubbleMenuAria.test.tsx` imports the real
`commentBubbleMenuTippyOptions` from `Editor.tsx` (not a copy) and calls the same `tippy(...)`
invocation `BubbleMenuView.createTooltip()` makes, against a stand-in `.tiptap-wrapper > div`,
asserting no element carries `aria-expanded`. It does not mount the real `<BubbleMenu>` +
`<EditorContent>` + a driven selection change: `@tiptap/extension-bubble-menu` is only a transitive
dependency of `web` (not resolvable directly from a test file), and its prebuilt ESM bundle's own
`import tippy from 'tippy.js'` does not interop cleanly through vitest's module runner reached via
that path — confirmed by direct experiment (`tippy` resolves to the whole CJS exports object, not
the callable, only through that nested import chain; a direct `import tippy from 'tippy.js'`
in a test file resolves correctly). That is a pre-existing environment limitation of this
dependency chain, not a defect under test — the same class `LazyEditor.test.tsx` already documents
("mounting real TipTap + Yjs in jsdom proves ... a great deal about jsdom").

Confirmed red first, for the right reason: with the unfixed (no `aria` key) options object, the
test failed with `AssertionError: Expected the element not to have attribute: aria-expanded /
Received: aria-expanded="false"` — not an import error or a locator failure.

**How to run it.**

```bash
pnpm --filter @ship/web test src/components/Editor.bubbleMenuAria.test.tsx
pnpm --filter @ship/web exec tsc --noEmit
```

To re-measure against a browser: start the worktree's API and Vite (`.factory-env` ports), log in
for a fresh `session_id`, open a wiki document, click into `.ProseMirror` to focus the editor, then
run an axe scan and check `aria-allowed-attr` is absent.

**Roll back.** Remove `aria: { expanded: false }` from `commentBubbleMenuTippyOptions` in
`Editor.tsx` (or `git revert` the commit on `fix/a11y-2-editor-aria`). The regression test fails
immediately if it comes back.

**Not established.** What a screen reader announces about the comment bubble menu — this fix only
removes an invalid ARIA attribute axe can detect; no human ran VoiceOver against it. The repo's
three Playwright a11y specs were not re-run here (not executed by the factory gate; they also only
assert `impact === 'critical'`, which this finding already was, so they would have caught it had
they scanned the focused-editor state — they scan static viewports only).

---

## TRO-190 (ERR-3) + TRO-191 (ERR-4) — the sync indicator stops claiming "Saved" over a write it never confirmed

Both findings are the same lie from two different causes. ERR-3 is a rejected title/property write
(429/500 on a PATCH). ERR-4 is a write against a document someone else already deleted (404).
Neither reaches the Yjs collaboration socket `SyncStatusIndicator` (TRO-188/ERR-1) watches — title
and properties are not CRDT content, they go straight over REST — so both used to leave the
indicator reading "Saved" with a rejected value still sitting in the field. `probe6-mixed.json`
(6.1/6.2): forced 429 then 500 on a rename, DB title unchanged both times, indicator stayed
"Saved". `probe7-retry-and-revocation.json` (7a): 14 PATCH attempts, a transient "Failed to update
document" toast fires, indicator still "Saved". `probe4-concurrency.json` (4c): another user
deletes the open document; this user's own typing keeps failing with 404, with **no** notice beyond
a console error on backlinks the user never sees.

**What changed.**

- `web/src/lib/queryClient.ts` gains `isNotFoundError`/`NOT_FOUND_STATUS` (same shape as the
  existing `isThrottleError`/`THROTTLE_STATUS` from API-1) and a small document-write-outcome bus
  (`subscribeToDocumentWriteOutcome`), fed from the real `MutationCache`'s `onError` (extended) and a
  new `onSuccess`, for any mutation tagged `meta.documentId`.
- `web/src/hooks/useDocumentWriteStatus.ts` (new) subscribes to that bus filtered to one
  `documentId`, exposing `hasFailedWrite` and calling `onDocumentGone` exactly once per document
  when a write 404s — so a retry storm (probe7a's 14 attempts) cannot open 14 blocking alerts.
- `web/src/components/editor/SyncStatusIndicator.tsx` — reused, not replaced: `deriveSyncIndicator`
  gains one optional input, `hasFailedWrite`, checked ahead of `isSynced`. A rejected write now
  overrides an otherwise-fully-synced Yjs socket and returns the exact same "Not saved" (red) view
  ERR-1 already built. No new state, no new copy in the indicator itself.
- `web/src/components/Editor.tsx` calls `useDocumentWriteStatus(documentId, () => alert(...))` and
  passes `hasFailedWrite` into the indicator. The one-time notice reuses the exact `alert()` pattern
  already in this file for the 4403 (access revoked) and 4100 (document converted) WebSocket close
  codes — not a new toast/modal system.
- `web/src/pages/UnifiedDocumentPage.tsx`'s `updateMutation` now attaches `.status` to the thrown
  error (it previously threw a bare `Error`, so `errorStatus()` could not see 429 vs 404 vs 500 at
  all) and tags `meta: { operation: 'update document', documentId: id }` so the bus above fires for
  it.

**New user-facing copy** — `Editor.tsx`, shown once per document, via the same blocking `alert()`
ERR-1's sibling fixes already use for this class of event:

> This document was deleted by someone else. Your changes here were not saved - copy anything you
> want to keep before leaving this page.

No other new copy or flow. The indicator itself reuses ERR-1's existing "Not saved" label and
detail text verbatim — this PR adds no new indicator copy.

**What did NOT change.** The field keeping the user's typed-but-unsaved text is pre-existing
`Editor.tsx` behaviour (`hasLocalChangesRef` / the `initialTitle` sync effect) and is untouched here
— rolling back the optimistic query-cache entry on a failed write never overwrote it, before or
after this fix. This PR only changes what the indicator is allowed to claim.

**Correcting TRO-190's own cross-reference.** TRO-190 describes ERR-3 as blocked on API-1's retry
predicates returning `false` for every 429/500. API-1 (TRO-172) is merged and that is no longer
true: `shouldRetryRequest` (`web/src/lib/queryClient.ts`) already retries 429 up to 4 times (delays
summing past the 60s rate-limit window) and plain 5xx/network errors up to 3 times, globally, as
the default for every mutation. The gap this PR closes is downstream of that: once retries
genuinely exhaust, nothing told the indicator. Separately, `UnifiedDocumentPage.tsx`'s mutation had
no `.status` on its thrown error, so a 429 hitting *this* mutation specifically fell back to the
generic 3-retry/1-2-4s schedule instead of the tuned one — too short to outlast the 60s window —
which this PR also fixes as part of attaching `.status` for the 404 case.

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/web exec vitest run \
  src/components/editor/SyncStatusIndicator.test.tsx \
  src/hooks/useDocumentWriteStatus.test.ts \
  src/lib/queryClient.test.ts
scripts/factory/gate.sh
```

**Verification note.** `probe6.1/6.2/7a/4c` need a live app with forced 429/500/404 responses; they
were not re-run here. The tests above drive the real `queryClient` `MutationCache` config directly
(the same technique `MutationErrorToast.test.tsx` already used for API-1) rather than a mock or a
mounted page, so they prove the actual production wiring reacts correctly — that is mutation-layer
proof, not a rerun of the original browser-level probes.

**Rollback.** Revert the commit(s) on `fix/err-3-err-4-silent-write-failure`. To disable
independently: pass `hasFailedWrite={false}` (or omit it) from `Editor.tsx` to restore ERR-1's
original indicator behaviour without touching `UnifiedDocumentPage.tsx`; or remove the
`meta: { documentId }` line there to stop the bus from ever firing for document writes.

---

## TRO-282 — [TEST-13] Program Weeks tab linked to a dead `/sprints/` route and bounced the user out

**Reproduced first, as the ticket required.** The finding was derived (read from `main.tsx` and
`UnifiedDocumentPage.tsx`, "nobody has reproduced this in a browser"). A component test rendering the
real route tree (`documents/:id/*` -> `UnifiedDocumentPage` -> the real program tab config -> the
real `ProgramWeeksTab`) and clicking a week card confirmed it: the app logged
`Invalid tab "sprints" for document type "program", redirecting to base URL` and the location became
the bare `/documents/:id` — no tab, no selected week. The bug was real, not rescued by a fallback.

**Root cause.** `web/src/components/document-tabs/ProgramWeeksTab.tsx` (lines 28, 34, 71 as of this
branch) navigated to `/documents/:id/sprints/:sprintId` on selecting or opening a week, and back to
`/documents/:id/sprints` from the week detail view. Commit 7713ef0 renamed the program tab's id from
`sprints` to `weeks` in `web/src/lib/document-tabs.tsx`, but the tab's own navigation calls were never
updated. `UnifiedDocumentPage.tsx`'s tab-validation effect (~line 93-102) treats any URL tab segment
absent from `tabConfig` as invalid and redirects to the bare document URL — so every click bounced.
Same root commit as five of the thirteen TEST-1 failures; TRO-223 fixed the tab *label* half, this is
the navigation half, which no unit test covered.

**What changed.**

- `ProgramWeeksTab.tsx` — all three navigate targets now point at `weeks` instead of `sprints`.
- `UnifiedDocumentPage.tsx` — added a small `LEGACY_TAB_ALIASES` map (`{ program: { sprints: 'weeks' } }`)
  consulted by the invalid-tab effect. A URL segment matching a known legacy alias now redirects to
  the tab's current id (preserving any nested path, e.g. the sprint/week id) instead of being treated
  as a plain invalid tab and dropped to the document root.

**Decision: redirect, not 404, for old `/sprints/` links.** The rename already shipped, so a bookmark
or shared link from before it is a normal, expected case — a 404 would be a second, quieter defect (a
link that silently stopped working) layered on top of the first. Redirecting keeps those links alive
with the same behavior a fresh rename-aware click gets.

**Regression test — `web/src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx`** (vitest, run by the
gate; this is the tier that actually executes, per `ship-qa`). Two cases:

1. Clicking a week card lands on `/documents/:id/weeks/:sprintId`, not the document root.
2. A bookmarked `/documents/:id/sprints/:sprintId` URL redirects to the equivalent `/weeks/` URL.

Confirmed red first, for the right reason: both cases failed with
`AssertionError: expected '/documents/prog-1' to be '/documents/prog-1/weeks/a1b2c3d4-…'`, and the
console carried the real `Invalid tab "sprints"...redirecting to base URL` warning — not a crash, not
a bad selector. After the fix, both pass with no warning.

**Also updated, additive only.** `e2e/program-mode-week-ux.spec.ts:369-417` asserted the stale
`/sprints/` URL after clicking/double-clicking a week card; updated to expect `/weeks/`. This suite is
not run by the gate or CI (`ship-qa`), which is exactly why the stale assertions never caught the
break — the vitest test above is the actual proof.

**How to run it.**

```bash
cd <worktree> && source .factory-env
pnpm --filter @ship/web test -- src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx
```

**Roll back.** `git checkout main -- web/src/components/document-tabs/ProgramWeeksTab.tsx
web/src/pages/UnifiedDocumentPage.tsx e2e/program-mode-week-ux.spec.ts && git rm
web/src/pages/UnifiedDocumentPage.programWeeksNav.test.tsx` and drop this entry.

---

## TRO-288 — [TEST-15] session-activity-race's "did the burst race" precondition was a scheduling hope, not a guarantee

**Not one of the audit report's 68 baseline findings** — a merge-queue blocker introduced by the
DB-2/API-6 work (TRO-179/TRO-177, PR #13) that landed on `main` afterward.

**What was broken.** `api/src/middleware/__tests__/session-activity-race.test.ts` fires a burst of
10 concurrent `authMiddleware()` calls via `Promise.all` and expects all 10 to read the session's
stale `last_activity` before any of them writes it. On an idle box `Promise.all` starting all 10
calls in the same synchronous tick is normally enough. It is not a guarantee: this repo's CI job
runs on a 2-vCPU `ubuntu-latest` runner with Postgres as a co-located service container sharing
those same 2 vCPUs (`.github/workflows/ci.yml`) — a far more contended environment than a dev
box — where connection acquisition and query dispatch can serialize enough that a later request's
SELECT lands after an earlier request's UPDATE has already committed. That request then correctly
reads the just-refreshed row and correctly skips writing, collapsing `updateStatements` to 1 and
failing the test's own "did the burst actually race" precondition
(`session-activity-race.test.ts:216-219`, `toBeGreaterThan(1)`). Because the test lives on `main`,
the factory gate compared this against the quarantine baseline and reported it as a *new* failure on
branches that never touch auth — observed blocking PR #29 (failed CI, then passed on a plain re-run
of the identical commit) and PR #11 (failed CI on this single identity, `newFailures: 1`).

**Correcting the ticket's own framing.** The ticket (and this test's name) describes the fragile
half as "modifies the session row exactly once." Confirmed directly, not inferred: reproducing the
non-overlapping case (a throwaway experiment invoking the burst fully sequentially instead of via
`Promise.all`, deleted before this commit) produced `updateStatements=1, rowsModified=1` —
the *precondition* check failed while the *exactly-once* check still passed. The exactly-once
assertion held in every timing pattern tried (fully concurrent, half-staggered, fully sequential);
Postgres's `WHERE ... AND last_activity < $3` predicate arbitrates correctly regardless of arrival
order, exactly as DB-2 intended. The fragile half was never "exactly once" — it was "did the burst
race at all."

**What changed — `api/src/middleware/__tests__/session-activity-race.test.ts` only.** Added
`createArrivalBarrier()`, installed as a plain property reassignment of `pool.query` *underneath*
the existing `vi.spyOn` (not through `mockImplementation`, which would collapse `pool.query`'s
overloaded signature to its last — callback-style — form, the wrong shape for this codebase's
promise-based calls). Also added two dedicated, database-free unit tests for the barrier helper
itself (`describe('createArrivalBarrier ...')`) — the release-on-count-reached behavior and the
passthrough for non-matching SQL — so a regression in the barrier's own logic fails fast rather than
only showing up as a reintroduced flake in the concurrent-burst test. The barrier holds every
session-lookup SELECT until all 10 concurrent callers
have asked to send one, then releases them together.

**Concurrency argument.** While any of the 10 calls is waiting at the barrier, none of them has yet
sent its SELECT, so none has read anything, so none can have decided a write is due, so no UPDATE
can exist yet. That makes it structurally impossible for any of the 10 SELECTs to observe anything
other than the original stale `last_activity` — not "unlikely under contention" but unreachable by
construction, independent of how slow or reordered the surrounding scheduling is. Validated by
instrumenting the barrier with an arrival counter and confirming all 10 arrivals fire before release
(temporary, removed before this commit) — the mechanism engages on the real SQL, it is not a no-op.

No fixed sleep was added or would help — this is a timing-determinism fix, and a sleep only
narrows a race, it does not close it.

**Not touched:** `api/src/middleware/auth.ts` — the throttle and its `WHERE`-clause predicate are
correct and unchanged. Verified by temporarily reverting the predicate to the pre-DB-2 unconditional
`UPDATE sessions SET last_activity = $1 WHERE id = $2` (file copied aside, never `git stash`d, and
restored — `git diff` against this branch shows zero changes to `auth.ts`): the barriered test goes
red for the right reason, `AssertionError: expected 10 to be 1`, i.e. all 10 requests now
deterministically raced and all 10 landed a write against the broken code. Restored immediately
after.

**How to run it.**
```bash
source .factory-env
pnpm --filter @ship/api exec vitest run src/middleware/__tests__/session-activity-race.test.ts
```
10 consecutive runs passed under deliberate load: 14 CPU-bound busy-loop worker processes (pure
`Math.sqrt` summation, no I/O) saturating all 14 physical cores of the host (load average
~40-54 on a 14-core machine), plus 3 concurrent full `pnpm --filter @ship/api test` suite runs
against a separate scratch database on the shared `ship-audit-pg` container, generating simultaneous
Postgres contention alongside the CPU load. All scratch load (busy-loop processes, the extra
database) was torn down after measurement. Standalone (no artificial load) and the full local api
suite (592/592) also pass. **Not verified**: reproducing the original CI failure directly on this
14-core dev machine — 20+ standalone/loaded attempts under busy-loop and concurrent-suite load did
not reproduce a failure against the pre-fix test, consistent with the mechanism needing CI's
specific 2-vCPU-shared-with-Postgres constraint rather than raw CPU contention on a larger box. The
fully-sequential white-box experiment (above) is the direct confirmation of the failure mode in lieu
of that reproduction.

**How to roll it back.** Revert this commit; the prior test file returns with the same
scheduling-dependent precondition. No production code, migration, or other file changes to undo.

---

## TRO-223 (TEST-1) — the web unit suite is green, and `pnpm test` now actually runs it

**13 web unit tests failed, in 3 files, and the root `pnpm test` never ran them.** Root `"test"` was
`pnpm --filter @ship/api test`, so `pnpm test` reported green while those 13 stayed red. CI *did*
run the web suite (`.github/workflows/ci.yml:105-118`, under `continue-on-error` with a quarantine
diff), so the failures were visible there — they were invisible to anyone running the suite locally,
which is where they needed to be caught. The suite
was 151 tests when the factory captured its baseline and 172 by the time this branch measured it —
the same 13 failing in both. They were five months of accumulated drift that a suite nobody ran
could not catch.

**The judgement this ticket turned on: for each failure, was the test wrong or the source wrong?**
It was not uniform, and it did not fall the convenient way. Of the 13: **11 were stale
assertions**, **1 was a source defect**, and **1 was a defect in the test harness**.

*Stale tests — 11 (source was right, assertions were corrected — a correction, not a weakening):*

- **`sprints` → `weeks` (5 assertions).** `7713ef0` renamed the tab id in both the project and
  program configs. `e2e/project-weeks.spec.ts:121` navigates to `/documents/:id/weeks`, confirming
  the new id is the live contract. Tests still asserted `'sprints'`.
- **Project tabs reordered (1 assertion).** `b1e4c5a` ("streamline navigation") moved `details`
  below `issues`, so a project opens on its issue list. The test asserted `details` was first.
- **Sprint documents gained tabs (2 assertions).** `9f77237` added a status-aware sprint tab set,
  landing *after* the test file was written. The tests asserted sprints had none.
- **`DetailsExtension` content model (1 assertion) and schema construction (2 errors).** The node's
  `content` is `'detailsSummary detailsContent'`; the test asserted `'block+'` and built an `Editor`
  without the two child nodes, so ProseMirror threw `No node type or group 'detailsSummary' found`.
  `Editor.tsx:628-630` registers all three together — the test now does the same.

*Source defect — 1 (the test was right; the product was fixed):*

- **`web/src/lib/document-tabs.tsx` — the project Weeks tab stopped showing its count.** In one
  hunk, `7713ef0` renamed the id *and* collapsed `label` from a count function to the bare string
  `'Weeks'` — while leaving the identical function intact on the program tab beside it. That
  asymmetry inside a single commit is the fingerprint of an accident, and
  `UnifiedDocumentPage.tsx:133,141` still fetches project weeks and computes `weeks:
  projectWeeks.length` for a consumer that no longer existed. Label function restored; the two
  callbacks are now byte-identical.

*Test-harness defect — 1 (no product code changed):*

- **`web/src/hooks/useSessionTimeout.test.ts` — the stub, not the hook, caused the phantom logout.**
  `lib/api.ts` reads `response.headers.get('content-type')`; the stub had no `headers`, so `apiPost`
  threw a `TypeError`, and `resetTimer` catches every throw as "network error — force logout".
  Observed, not inferred: stderr printed `Network error extending session - forcing logout` — the
  `catch` branch — and never `Failed to extend session`, the `!response.ok` branch. **The assertion
  was correct and is untouched, and the hook's fail-closed logout was deliberately left alone**: a
  session that cannot be extended *should* end. Only the stubs changed — they now hand the code
  under test a real `Response`. Two new tests assert the logout still fires when extend-session
  returns non-ok or rejects, so "fixed the stub" and "neutered the logout" cannot be confused.

**Also changed.** Root `"test"` is now `test:api && test:web`, with `test:api`/`test:web` for
single suites. CI already ran both (`.github/workflows/ci.yml:105-118`) and diffs them against the
quarantine baseline, so this closes the *local* gap only — it does not duplicate CI. All 13
entries were removed from `audit/factory/quarantine.json`; both suites are now green on arrival.
`README.md:43`, which documented this finding as open, is updated.

**Run it.**

```bash
pnpm test:web                    # 345 passed / 345 total, 33 files
pnpm test                        # api (needs DATABASE_URL), then web
scripts/factory/gate.sh          # full evidence gate
```

Those totals are measured on this branch *after* merging `main` a second time (`main` moved from
`84f05ff` to `f7b15c9`, nine more PRs, including route-level code splitting and a deferred editor).
That merge brought in another round of web test files written by other tickets. Sequence of
measurements on this branch: 186 tests before the first `main` merge, 214/214 across 24 files
after it, 345/345 across 33 files after this second one — the 13 identities this ticket fixes did
not change across any of those merges, only the file count around them did.

15 test cases were added to the three repaired files: sprint status-aware tab selection (previously
uncovered — which is how `getTabsForDocumentType('sprint')` drifted from `[]` to four tabs
unnoticed), project/program week count-label symmetry, the zero-count convention asserted across
every count-aware label, a guard that no config exposes a `'sprints'` id again, `setDetails`
document structure, and the two session fail-closed tests. Assertions in the three repaired files
went from 131 to 147.

**Correction post-merge.** The `fix(web): drop test-side casts` commit's message claimed both
test-side casts flagged by CodeRabbit were removed. Only the `useSessionTimeout.test.ts` fetch cast
was; `DetailsExtension.test.ts`'s pre-existing `(editor.commands as any).setDetails` — inside the
same quarantined test this ticket claims to have fixed, `should allow inserting details via
command` — was untouched and still present after merging `main`. Removed now (no cast needed:
`setDetails` is typed via module augmentation, same as the sibling test already relied on).
`node scripts/factory/review-patterns.mjs main` reports clean before and after, because the cast
predates this branch and G7b only diffs added lines — it would not have caught this on its own.

**Roll back.** `git revert` the commits on `fix/test-1-web-suite-green`. Reverting restores the 13
failures, so the `knownFailing` list in `audit/factory/quarantine.json` must come back too —
otherwise the gate reads them as new regressions and fails every branch.

`previousCapture` now carries the 13 identities directly, under `previousCapture.webKnownFailing`.
Copy them back into `packages.web.knownFailing`; no git archaeology required.

Two traps were found while writing this, both worth knowing:

- `previousCapture` originally held only `capturedAt`, `capturedAtCommit` and `totals` — so the
  earlier instruction to "restore from `previousCapture`" pointed at data that was not there.
- The obvious replacement was equally wrong. `capturedAtCommit` (`ae2a00e`) is the commit the
  **measurement** was taken against; `audit/factory/quarantine.json` **did not exist yet** at that
  commit, so `git show ae2a00e:…` fails outright. The file was introduced at `ea2dcd3`, now recorded
  as `previousCapture.fileAtCommit`.

That is why the identities are stored inline rather than referenced: a rollback instruction is read
under pressure, and two successive versions of this one pointed somewhere that could not answer.

---

## TRO-284 (ERR-11) + TRO-285 (ERR-12) — the collaboration server stops dropping frames and serving blank documents during its own document load

**The user-facing cost.** Two ways a collaborative editor could load and simply show nothing, with
no error anywhere. ERR-11: a client's very first sync message could vanish silently, so the editor
sat empty forever with no server reply. ERR-12: a second person opening the same not-yet-open
document at the same moment as a first could get a blank document that never fills in. Observed for
ERR-12, non-deterministically, at `--workers=1 --retries=0`: run 1 clean, run 2 the weekly **plan**
opened blank, run 3 the **retro** opened blank.

**Root cause — one mistake, found three times.** `wss.on('connection')` in
`api/src/collaboration/index.ts` is `async` and `await`s a database round trip before the socket is
fully wired up. Everything registered after that `await` — a message listener, a shared cache entry
— is exposed to whatever arrives in the gap between the moment a connection becomes reachable and
the moment it can actually respond. This is the same defect class as the already-merged ERR-10 (an
`'error'` listener attached after an `await`); ERR-11 and ERR-12 are the `'message'`-listener and
document-cache versions of it, found independently by two different agents on the same day.

- **ERR-11**: `ws.on('message')` was registered only after `await getOrCreateDoc()`. A
  `y-websocket` client sends sync step 1 on the very first tick after `'open'`; a frame landing in
  the gap had no listener, and Node's `EventEmitter` discards an event with no listener **silently**
  — no error, no log, nothing. The server never replies with step 2, so the client never learns the
  server's state. Observed deterministically on loopback before the fix: frames received were
  `[3, 0, 1, 1]` (cache-clear, the server's own step 1, two awareness updates) and no step 2, ever.
- **ERR-12**: `getOrCreateDoc()` (`api/src/collaboration/index.ts`) published a brand-new `Y.Doc`
  into the shared `docs` map **before** awaiting the database read and the JSON→Yjs conversion, and
  attached the broadcasting `doc.on('update')` handler only afterwards. A second connection arriving
  in that gap found the doc already cached — so it triggered no load of its own — received the
  **empty** doc as its server state, and had no listener yet attached to notice when the real
  content landed a moment later.

**What changed.**

- **ERR-11.** `ws.on('message')` is now registered as a **bounded buffering handler** right after
  ERR-10's error-listener registration (still the first statement) and, like it, before the `await`.
  Frames that arrive before the document has
  loaded are queued, not processed — processing them early against a `doc`/`Awareness` that do not
  exist yet would just move the bug. Once the load finishes, the buffering listener is swapped for
  the real one and the queue is drained, in order — all within the same uninterrupted synchronous
  stretch of code that already sent the server's own sync step 1, so replying to a drained client
  step 1 remains race-free, the same invariant `concurrent-merge.test.ts` already relied on for the
  server's outbound step 1. The buffer is bounded at **1 MiB of buffered bytes**
  (`MAX_PRELOAD_BUFFER_BYTES`): this handler sees attacker-controlled bytes before their content can
  be validated (ERR-10's own finding), so an unbounded queue during the load window is a
  memory-exhaustion vector. Exceeding the bound closes the socket with a new code,
  `WS_CLOSE_PRELOAD_BUFFER_FULL` (4429, mnemonic HTTP 429), rather than growing further.
- **ERR-12.** The `docs` map now stores the **load promise**, not the eventual `Y.Doc`
  (`loadDoc()` / `getOrCreateDoc()`). A second caller arriving while the first is still loading
  awaits that same promise and is guaranteed a fully-loaded doc — there is no intermediate step at
  which an unloaded doc is ever handed to anyone, which removes the window rather than narrowing it.
  `doc.on('update')` is attached before the database read / JSON→Yjs conversion, not after, so the
  very first update — the one that carries the loaded content — has a listener. A failed database
  read now **rejects** (previously it was swallowed and the doc silently stayed empty) and
  **evicts** its own map entry, but only if it is still the current entry — a caller that arrived
  after the failure may already have published a fresh attempt of its own, and an unconditional
  delete would tear that down instead. Malformed *stored data* (a corrupt `yjs_state` blob,
  unparsable JSON `content`) is deliberately **not** treated the same way: retrying decodes the exact
  same bytes again, so those two branches keep their own try/catch and fall back to an empty
  document, matching this function's behavior before ERR-12.

**Concurrency argument.** Both fixes close the window instead of narrowing it. ERR-11 no longer
depends on the message listener winning a race against the database read, because every frame that
can arrive before the doc is ready is captured (bounded) and replayed in order — there is no gap
left in which a frame has nowhere to go. ERR-12 no longer depends on one connection's read of the
`docs` map happening to land after another's load completes, because the map holds the one promise
every concurrent caller converges on; "the doc is in the map but not yet loaded" is no longer a
state the map can be in.

**Provenance, marked.** ERR-11's mechanism was reproduced directly (not merely reasoned about): a
regression test connects and writes in the same tick as `'open'`, red on the pre-fix module with the
exact `[3,0,1,1]` frame signature the ticket predicted. ERR-12's two-concurrent-caller mechanism was
also **observed directly** — a test issues two `getOrCreateDoc()` calls back to back and shows the
second one returning an empty doc on the pre-fix logic, an `AssertionError`, not a crash — which is a
step up from "derived from code, not instrumented," the state this finding was in when picked up.
What was **not** independently instrumented is a live two-socket connection count in a running
server outside the test harness; the two-real-socket regression test below is the closest evidence
of that shape and it is described as such, not as proof of a separately-measured connection count.

**How to run it.**

```bash
source .factory-env   # api tests TRUNCATE 16 tables; never run without this
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/preload-message-buffer.test.ts
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/concurrent-doc-load.test.ts
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/concurrent-merge.test.ts
```

`preload-message-buffer.test.ts` (ERR-11): a frame sent in the same tick as `'open'` is processed,
not dropped; flooding past `MAX_PRELOAD_BUFFER_BYTES` closes the socket with
`WS_CLOSE_PRELOAD_BUFFER_FULL` instead of growing the queue. Both cases force a **real** load delay
(no mocked timing) by seeding the target document with a large `content` value, which measurably
slows the one database read `loadDoc()` issues (~70-110ms observed locally for a 20MB value, versus
well under 1ms for a small row) — long enough to reliably land inside the window without touching
production internals.

`concurrent-doc-load.test.ts` (ERR-12): two `getOrCreateDoc()` calls issued back to back resolve to
the same, fully-loaded doc; a load failure (a syntactically invalid UUID — a real Postgres error,
not a mock) rejects and evicts, proved by observing that a second call issues a **fresh** query
rather than reusing a cached rejection; two real clients connecting simultaneously to the same
not-yet-loaded document both receive the seeded content rather than a blank one.

`concurrent-merge.test.ts` (TRO-226/TEST-4, already on `main`) documented the ERR-11 drop as a
workaround: it withheld a client's sync step 1 until after the server's first frame, specifically to
dodge the bug. That workaround is now removed — the acceptance signal for ERR-11 — and the file
still passes: red first (2 of 4 cases timed out waiting for sync step 2, frame signature
`[3,0,1,1]`), green and **faster** after the fix (10.5s vs 44.5s wall time, no timeouts).

No fixed sleeps (TEST-11 / TRO-233): every wait is an observable — a socket `'close'` event, a
database row polled until a predicate holds, or a Yjs `update` event.

**How to roll it back.**

```bash
git revert <commit>
```

No schema change, no migration, no config, no API surface change for a well-behaved client. Reverting
restores both windows: `ws.on('message')` moves back after the `await`, and `docs` goes back to
storing the doc directly instead of its load promise.

---

## TRO-279 — [DB-12] Concurrent `pnpm db:migrate` is broken — 5 of 6 simultaneous schema applies failed

**What was broken.** `CREATE TABLE IF NOT EXISTS` (and `CREATE INDEX IF NOT EXISTS`) is
check-then-create, not atomic. Two `pnpm db:migrate` processes racing against the same database
could both pass the existence check and both attempt the create; one loses on the catalog's unique
index. `Dockerfile:35` runs migrations on every container boot, so a rolling deploy, a scale-out, or
a crash-restart overlapping a fresh boot runs this concurrently against one database — this is not a
theoretical race, it is the normal shape of this deployment.

**Why it was worse than a failed deploy.** `applySchema` runs `schema.sql` as one simple query, so
Postgres executes it as a single implicit transaction: a duplicate-object error at statement *k*
rolls back statements 1..*k*-1 too. PR #8 (TRO-178) put `42710` in the tolerated-error set and added
a retry, which recovers *that* case — but the raw race mostly raises **23505** (`unique_violation` on
`pg_type_typname_nsp_index`), which is deliberately *not* tolerated (23505 is the generic
unique-violation code; tolerating it would also swallow a genuine data conflict). Left unfixed, a
losing run under a still-tolerant retry policy could apply nothing and still exit 0 — DB-1's exact
failure mode, reachable only through this race.

**What changed.** `api/src/db/migrationRunner.ts` — `runMigrations` now takes one Postgres
**session-level advisory lock** (`pg_advisory_lock` / `pg_advisory_unlock` on a fixed key,
`MIGRATION_ADVISORY_LOCK_KEY = 0x53686970`, spelling "Ship" in hex) around the entire run: `applySchema`,
`ensureMigrationsTable`, and the migration loop in `runPendingMigrations`. The lock is acquired
**before** anything else touches the database — in particular before `runPendingMigrations`' first
query, the `schema_migrations` read — because locking after that read would preserve the exact race
this closes.

- A single `PoolClient`, checked out once for the whole run, now flows through
  `applySchema`/`ensureMigrationsTable`/`runPendingMigrations` instead of each call going through
  `pool.query(...)` independently. `runPendingMigrations` no longer opens its own connection per
  migration file; each migration's transaction now runs sequentially on the one client that holds
  the lock. This means the fix does not depend on the pool having a second connection free while the
  lock-holder is checked out — it works even against a pool sized for exactly one connection.
- The lock is released in a `finally` on every exit path, success or failure. The unlock call is
  wrapped in its own inner `try/catch` so that if unlocking itself fails, it cannot mask a real error
  already propagating from the migration work. If the explicit unlock did not run or failed, the
  connection is force-destroyed (`client.release(true)`) instead of returned to the pool — ending the
  session is the backstop that still releases the lock even when the explicit unlock command could
  not be sent.
- **Concurrency argument.** A second `pnpm db:migrate` process blocks at `pg_advisory_lock` until the
  first releases (or its session ends), so the two runs' critical sections cannot overlap in time —
  this closes the window rather than narrowing it. A runner that dies while holding the lock does not
  wedge every future run: session-level advisory locks are released when their session ends, cleanly
  or otherwise (documented Postgres behaviour), and this is verified directly — not just assumed —
  by a test that opens a lock, ends that connection without unlocking, and confirms a second
  connection can then acquire it immediately.
- **`applySchema`'s duplicate-object retry (from PR #8) is left in place, not removed.** With the
  lock held, only one session is ever inside `applySchema` at a time, so the concurrent case it was
  added for should no longer reach it — but it is still the correct response to a genuine
  non-concurrent duplicate-object error (a stray manual `psql` session, a future caller that bypasses
  the lock), and removing a defensive path that is merely believed-unreachable is out of scope here.
- **The tolerated-error set is unchanged — 23505 is still not in it.** Widening it would swallow a
  real data conflict the day `schema.sql` stops having zero DML; the lock removes the need to
  tolerate the concurrent case at all, which is the point of fixing this at the actual race instead
  of widening what errors are forgiven.
- Regression tests: `api/src/db/__tests__/migrationLock.test.ts` (new). `MIGRATION_ADVISORY_LOCK_KEY`
  is now exported from `migrationRunner.ts` so tests can assert the lock is actually free via
  `pg_try_advisory_lock`, rather than only inferring release from a second run's success.

**How to run it.**

```bash
source .factory-env                      # or otherwise point DATABASE_URL at the target
pnpm db:migrate
pnpm --filter @ship/api test src/db/__tests__/migrationLock.test.ts
pnpm --filter @ship/api test src/db/__tests__/migrationRunner.test.ts   # DB-1 regressions, unaffected
```

**Verified**, all against PostgreSQL 15 in the `ship-audit-pg`-style container on `:5433`, using the
real `tsx src/db/migrate.ts` entry point (what `pnpm db:migrate` invokes) unless noted:

- **Before the fix** (pre-fix `migrationRunner.ts` restored from `main`, six `tsx src/db/migrate.ts`
  processes launched concurrently against one fresh throwaway database): 1 of 6 exited 0, 5 of 6
  exited 1, all five with SQLSTATE `23505` on `pg_type_typname_nsp_index` — reproducing the ticket's
  numbers with this branch's own harness before trusting it.
- **After the fix**, same harness, a fresh throwaway database: all six processes exited 0,
  `schema_migrations` held exactly 42 distinct rows, no duplicate-object or unique-violation output
  in any of the six logs.
- A single, non-concurrent `tsx src/db/migrate.ts` against a fresh throwaway database: exit 0, 42/42
  migrations recorded.
- A genuine failure (a deliberately broken migration file added temporarily, removed immediately
  after) via the real CLI: exit 1, naming the failure — DB-1's exit-non-zero guarantee still holds
  and is unaffected by this change (`migrate.ts` itself was not modified).
- `api/src/db/__tests__/migrationLock.test.ts`, run against the **pre-fix** runner first: the
  six-concurrent-runs test failed with five real `23505` `unique_violation` errors (red for the
  right reason); the two lock-semantics tests failed too, but because `MIGRATION_ADVISORY_LOCK_KEY`
  does not exist on the pre-fix module — expected, since those tests exercise a lock that does not
  exist yet. Restoring the fix turned all three green.
- `pnpm --filter @ship/api test` (full suite, factory database `ship_wt_tro_279`): 43 files, 595
  tests, all green.
- `pnpm --filter @ship/api exec tsc --noEmit`: clean.

**Not verified.** No run against PostgreSQL 16 (production; CI and this work run pg15 — see the pin
in `.github/workflows/ci.yml`), and no run against production or shadow. The advisory-lock mechanism
itself is standard Postgres behaviour independent of major version, but this was not measured against
16 directly.

**Rollback.** `git revert` the commit(s) on `fix/db-12-migrate-advisory-lock`, or restore
`api/src/db/migrationRunner.ts` from `main` and delete `api/src/db/__tests__/migrationLock.test.ts`.
Rolling back returns `pnpm db:migrate` to PR #8's retry-only mitigation — `42710` recovers, `23505`
does not, and the race described above is live again. No database state is affected by rolling back;
the lock itself leaves no persistent artifact (advisory locks are session-scoped, never written to
disk).

---

## TRO-240 — [DB-11] The application's database pool negotiated no TLS while migrate and seed did

**What was broken.** Three pools connect to Ship's database with three different SSL policies.
`api/src/db/migrate.ts:32` and `api/src/db/seed.ts:44` each carried their own copy of
`ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false`.
`api/src/db/client.ts:17-26` — the pool the entire running application uses — had **no `ssl` key at
all**. A fourth pool, `api/src/db/scripts/orphan-diagnostic.ts:34`, had none either.

An absent `ssl` key is not "let pg decide sensibly". `pg`'s `ConnectionParameters` does
`this.ssl = typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() : config.ssl`, and
with `PGSSLMODE` unset that resolves to `defaults.ssl`, which is `false`
(`pg/lib/connection-parameters.js:100`, `pg/lib/defaults.js:43`). So the app pool connected in
**plaintext**, unconditionally, in production.

**Why it never surfaced on AWS.** Aurora is in-VPC and the connection is internal, so plaintext
works. The gap only appears against a managed Postgres that requires TLS on a public endpoint —
i.e. every PaaS, including the Render deployment.

**Why the failure signature misdirects.** `Dockerfile:35` is
`node dist/db/migrate.js && node dist/index.js`. `migrate.ts` *did* configure SSL, so it connected,
ran, exited 0, and the `&&` proceeded — then `index.js` started and `client.ts` failed to connect.
The logs read "migration succeeded, database unreachable", which looks like a database problem
rather than a client-config one. `connectionTimeoutMillis: 2000` turned it into a fast crash-loop
instead of a legible TLS error.

**What changed.** The drift was the defect, so the fix is one decision in one place rather than a
fourth copy of the ternary. New `api/src/db/ssl.ts` exports `resolveDatabaseSsl(nodeEnv?)`, and all
four pools under `api/src/db/` now call it:

- `api/src/db/client.ts:23` — **the actual bug**; previously passed nothing.
- `api/src/db/migrate.ts:33`, `api/src/db/seed.ts:45` — inline ternary replaced by the helper.
- `api/src/db/scripts/orphan-diagnostic.ts:37` — previously passed nothing; same defect class.

The returned value is unchanged from what the scripts already did: `{ rejectUnauthorized: false }`
in production, `false` otherwise. A fresh object per call, so no two pools share a mutable TLS
config. `nodeEnv` is a parameter defaulting to `process.env.NODE_ENV` purely so the decision is
testable without env stubbing; production code calls it with no arguments.

**Behaviour outside production is byte-for-byte identical.** Local dev, CI and the factory
databases previously got `false` by pg's default and now get `false` by explicit decision.

**`rejectUnauthorized: false` was carried over deliberately, not endorsed.** It encrypts the
connection but does not verify the server certificate chain — it stops passive eavesdropping, not an
active man-in-the-middle. Managed providers sign with their own CA, absent from Node's trust store,
so verification fails without the provider bundle. A federal deployment probably wants
`rejectUnauthorized: true` plus an explicit `ca`. Tightening it here would be a silent posture
change that no test in this repo can verify, so it is left as a follow-up that needs the CA bundle
decided first. This is called out in the header comment of `api/src/db/ssl.ts`.

**Precedence — the helper is not the only input, and not the strongest.** There is a third SSL
surface besides these pools and the helper: the connection string. Raised by CodeRabbit, then
established by reading pg rather than inferring it from the finding above, and confirmed empirically
against pg 8.16.3 / pg-connection-string 2.9.1.

`pg/lib/connection-parameters.js:56` does
`config = Object.assign({}, config, parse(config.connectionString))` — the parsed URL is the **last**
source, so its `ssl` key overwrites the caller's; the comment on `:54` says so outright.
`pg-connection-string/index.js:76` sets `ssl = {}` whenever `sslmode` is present, and `:133-135` sets
`ssl = false` for `disable`. `connection-parameters.js:81` then uses that value as-is.

Effective order, weakest to strongest: **pg defaults → `PGSSLMODE` → the `ssl` option this helper
returns → `sslmode` in the connection string.**

Measured, passing an explicit `{ rejectUnauthorized: false }` throughout:

| `sslmode` in URL | effective `ssl` | on the wire |
|---|---|---|
| absent | `{ rejectUnauthorized: false }` | encrypted — our option survives |
| `disable` | `false` | **plaintext — our option is discarded** |
| `prefer` / `require` / `verify-ca` / `verify-full` | `{}` | encrypted |
| `no-verify` | `{ rejectUnauthorized: false }` | encrypted |

So `DATABASE_URL=...?sslmode=disable` silently defeated the fix, in exactly the way these strings
arrive — copied from a provider dashboard. The helper would report the right value, every test would
pass, and production would be in the clear.

The `ssl` option can never win that argument, so `resolveDatabaseSsl` **refuses to start** instead:
in production, an `sslmode` that pg resolves to plaintext throws with the parameter named and the
remedy stated. `disable` is the only such value — the other five all encrypt, and are allowed
through untouched. Outside production `sslmode=disable` is still fine, because local Postgres and
the CI container are plaintext-only.

It deliberately does **not** rewrite the URL. Silently editing an operator's explicit instruction is
the same class of mistake as the original bug: the code would report one thing and do another.

Note in passing: `sslmode=require` resolves to `{}`, which leaves Node's `rejectUnauthorized` at
`true` — stricter than this helper, and it will **fail** against a provider using a private CA. That
is a loud connection error rather than a silent downgrade, so it is left alone.

**Deployment precondition — check this before rolling out.** If the production `DATABASE_URL` in SSM
already contains `sslmode=disable`, this turns a currently-working in-VPC deploy into a startup
failure with the message above. The value lives in SSM and could not be inspected from here, so this
is stated as a risk, not a cleared check. If plaintext is genuinely intended for that deployment,
that is a decision for a human to make explicitly.

**Out of scope, deliberately.** `api/scripts/migrate-shadow.ts:32`, `api/scripts/create-test-user.ts:35`
and `api/scripts/check-db-user.ts:10,19` set `ssl: { rejectUnauthorized: false }`
**unconditionally** — a fifth and sixth policy. They are operator scripts outside
`api/tsconfig.json`'s `include: ["src/**/*"]`, always pointed at a remote AWS endpoint. Routing them
through a `NODE_ENV`-conditional helper would silently **downgrade** them to plaintext whenever
`NODE_ENV` is unset, which is how they are normally invoked. Changing them needs its own ticket and
its own verification.

**Evidence.** `pnpm --filter @ship/api test` against
`postgresql://ship:***@localhost:5433/ship_wt_tro_240` (docker `ship-audit-pg`, postgres:15-alpine),
`NODE_ENV` unset in the shell so vitest sets `test`. 31 files, **491 passed, 0 failed**.
`pnpm --filter @ship/web test`: 13 failed / 186 passed — the same 13 identities quarantined as
TEST-1 / TRO-223, in the same three files; nothing in `web/` was touched. `pnpm type-check` clean
across shared, api and web.

The regression test is `api/src/db/__tests__/ssl.test.ts` (22 cases), covering four things:

1. the decision per `NODE_ENV`, including that `production` is matched exactly, so a deploy setting
   `NODE_ENV=Production` cannot silently drop to plaintext;
2. that `client.ts`'s pool actually applies it — re-imported under a stubbed env, since the pool is
   built at module scope. **7 failed / 8 passed** against the unfixed call sites, every failure an
   `AssertionError` on the claimed behaviour, the headline being
   `expected undefined to deeply equal { rejectUnauthorized: false }` — DB-11 stated as a test;
3. the precedence above: two tests **characterise pg itself**, pinning that `sslmode=disable`
   discards the explicit option and that the other five values do not. If a future pg makes the
   option win, those tests fail, which is the signal the throw can be relaxed. Then the guard:
   **2 failed / 6 passed** against the unguarded helper, both `expected [Function] to throw an
   error`. Only two of the eight went red on purpose — the other six assert behaviour that must
   *not* change (dev still permits `sslmode=disable`, encrypting modes still pass, a malformed URL
   is still pg's to report);
4. that **no** pool under `api/src/db/` sets `ssl` to anything other than `resolveDatabaseSsl()`.
   This is what prevents recurrence — a future file adding `new Pool(...)` with its own policy fails
   the suite rather than quietly adding a fifth policy.

Beyond the suite, the **compiled** artifact was exercised directly, since `Dockerfile:35` runs
`dist/`, not the TypeScript: `NODE_ENV=production` with a clean URL yields
`{"rejectUnauthorized":false}`; with `?sslmode=disable` importing `dist/db/client.js` throws the
guard message; `NODE_ENV=development` with `?sslmode=disable` still yields `false`.

**How to run it.**

```bash
source .factory-env                                             # api tests TRUNCATE 16 tables
pnpm --filter @ship/api test src/db/__tests__/ssl.test.ts       # 22 cases, the regression test
pnpm --filter @ship/api test                                    # full api suite: 491/491
pnpm type-check

# the guard, on the compiled artifact (throws; prints the remedy)
pnpm --filter @ship/api build
cd api && NODE_ENV=production DATABASE_URL='postgresql://u:p@h:5432/d?sslmode=disable' \
  node -e "import('./dist/db/client.js').catch(e => console.log(e.message))"
```

**Rollback.** `git revert` the commits on `fix/db-11-pool-ssl`, or by hand: delete
`api/src/db/ssl.ts` and `api/src/db/__tests__/ssl.test.ts`, drop the `ssl:` line and the import from
`client.ts` and `scripts/orphan-diagnostic.ts`, and restore the inline ternary in `migrate.ts` and
`seed.ts`. Reverting reinstates plaintext connections from the application pool. To keep the fix but
drop only the startup guard, delete the `PLAINTEXT_SSL_MODES` check in `resolveDatabaseSsl` — that
restores the state where `sslmode=disable` in `DATABASE_URL` silently wins.

**Not verified — do not read this as a fixed deployment.** No test here proves TLS actually
negotiates. Proving that needs a managed Postgres endpoint that *requires* TLS on a public address;
there is none in this repo's test environment, and the local docker Postgres speaks plaintext only,
so a passing local suite is silent on the real failure mode. What is verified is the decision logic
and its propagation to all four call sites — everything up to the socket. The claim "Render now
starts" remains **untested**; confirming it means deploying and reading the startup logs.

---

## TRO-226 — [TEST-4] Concurrent multi-client editing / Yjs merge had no executing test

**What was missing.** The CRDT is the entire justification for the Yjs architecture
(`docs/unified-document-model.md`), and nothing verified it. A regression that silently dropped one
collaborator's edits would have shipped green. Two tests looked like they covered this and did not:

- `api/src/collaboration/__tests__/collaboration.test.ts:144` "should merge concurrent Yjs updates
  correctly" exchanges updates between two bare `Y.Doc`s with `Y.applyUpdate`. That is a test of the
  yjs library. No server, no socket, no persistence — a bug in
  `api/src/collaboration/index.ts` cannot fail it.
- `e2e/mentions.spec.ts:374` is the only two-client test. It uses `browser.newPage()` (one browser,
  sequential), every assertion sits inside `if (await option.isVisible())`, and it synchronizes with
  `waitForTimeout(2000)`/`waitForTimeout(3000)`. It is also in `e2e/`, which neither `gate.sh` nor
  `.github/workflows/ci.yml` executes.

**What changed.** One new file, `api/src/collaboration/__tests__/concurrent-merge.test.ts`, in the
vitest project the gate actually runs. Four tests drive two independent Yjs clients — separate
`Y.Doc`s, separate WebSockets, separate sessions — against the real `setupCollaboration()` over real
sockets, speaking the real `y-protocols` sync protocol in **both** directions, and assert on the
`documents` row.

- **control** — one client's edit reaches `content` and `yjs_state`. Without this, a broken harness
  and a broken merge look identical.
- **different regions** — both clients append a paragraph in one synchronous block, so neither
  update is in the other's causal history. Concurrency is *asserted*, not assumed: each replica must
  not yet contain the other's marker at edit time. Then both replicas must converge to a
  byte-identical document containing both edits, and both edits must be in `yjs_state`.
- **same region** — the crux. A seeded paragraph is the contested text; both clients insert at the
  same character offset in the same `Y.XmlText`. Asserts both inserts survive, the replicas converge
  on one identical string, and the pre-existing text is intact. The interleaving *order* is
  deliberately not asserted — Yjs breaks the tie by client id, which is not stable across runs.
- **offline divergence** — one client's socket is closed, it edits anyway, the other edits online,
  then it reconnects. Asserts the offline edit is merged in rather than discarded, the online edit is
  not clobbered, and the result persists. This is the expensive regression: a user's work silently
  lost on reconnect.

Persistence is checked by decoding `documents.yjs_state` into a fresh `Y.Doc` in the test process,
not by trusting the `content` JSON mirror. `api/src/collaboration/index.ts` is **not modified** —
this is coverage only, and three branches are in flight against that file.

**Plus an additive browser spec, clearly labelled as not run by CI.**
`e2e/concurrent-editing.spec.ts` does the same two scenarios through two real
`browser.newContext()`s — separate cookie jars, separate sessions, separate IndexedDB — logged in as
two different users, typing concurrently via `Promise.all` on two keystroke streams. It covers the
one layer the vitest test cannot reach: TipTap and the real `y-websocket` client rather than a
hand-rolled protocol client. It is **additive, not the proof** — `.github/workflows/ci.yml` has no
Playwright job and `gate.sh` executes only the two vitest projects, so a test living only in `e2e/`
satisfies the gate's added-test check while never running. That is the TEST-2 failure mode, and the
file's header says so.

**No fixed sleeps.** Convergence is awaited on Yjs `update` events. Persistence — which emits no
event — is awaited by re-reading the row until a predicate holds, with a 50ms gap between reads and
a hard deadline. Every wait is a condition, never a duration guessed to be long enough (TEST-11 /
TRO-233).

**How to run it.**

```bash
cd <worktree> && source .factory-env      # api tests TRUNCATE 16 tables
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/concurrent-merge.test.ts

# the additive browser spec — deliberate, never as part of the full suite
pnpm build && npx playwright test e2e/concurrent-editing.spec.ts --workers=1 --retries=0
```

**Evidence — the test was proved capable of failing.** New coverage has no bug to go red on, so the
server was temporarily sabotaged twice (both reverted; `git diff main -- api/src/collaboration/index.ts`
is empty on this branch).

1. *Merge sabotage* — `handleMessage` was made to silently discard `messageYjsUpdate` frames from any
   client that is not the first connection in the room. Both concurrent tests failed; the control and
   offline tests still passed, so the harness was provably fine. Failure text:
   `clientA never received clientB's concurrent edit (BOB_…) — local replica:
   <paragraph></paragraph><paragraph>ALICE_…</paragraph> frames received: [3,0,1,0,1]`.
2. *Persistence sabotage* — the `UPDATE documents SET yjs_state = …, content = …` in
   `persistDocument()` was reduced to writing only `properties`. In-memory merge still worked; all
   four tests failed on the database assertion:
   `merged content never reached documents.content: database predicate never held within 30000ms
   (576 reads)`.

Both are `AssertionError`/explicit-condition failures naming the missing edit, not import or setup
errors.

The **e2e spec was proved capable of failing too**, under the same merge sabotage (rebuilt through
`pnpm --filter @ship/api build`, since the e2e harness runs `api/dist/index.js`). Both browser tests
failed with `Error: clientA lost clientB's concurrent edit / Expected substring: "BBB-…" / Received
string: "AAA-…"`, then passed again after the source was restored and rebuilt.

**Stability.** 5 consecutive standalone runs of the vitest file, 4/4 passing each time, ~10.4s per
run. Full api suite green: 473 passed / 31 files (up from 469 / 30). The e2e spec: 2/2 passing,
verified with `--retries=0` so a retry cannot mask a flake, ~33-51s for the pair on one worker.

**Coverage delta on `api/src/collaboration/index.ts`.** v8 provider, full api suite
(`vitest run --coverage`), factory database `ship_wt_tro_226` on the `ship-audit-pg` container at
`:5433`, macOS, measured twice under identical conditions with the new file present and absent:

| | statements | branches | functions | lines |
|---|---|---|---|---|
| without this test | 60.68% | 40.57% | 67.24% | 62.07% |
| with this test | **62.50%** | **45.41%** | **70.68%** | **63.04%** |

The ticket's "25.0% function coverage (7 of 28)" figure is **not reproducible today** and is not the
baseline above: `session-revocation.test.ts` (ERR-2 / TRO-189) landed on the same file earlier the
same day and had already lifted functions to 67.24%. The v8 provider also counts closures, so its
denominator is not 28. `@vitest/coverage-v8` is not a dependency of this repo; it was installed to
take the measurement and `api/package.json`/`pnpm-lock.yaml` were reverted afterwards, so
`--coverage` will not run without installing it again.

**Second new finding, not fixed here, and it probably affects other e2e specs.**
`web/src/components/ActionItemsModal.tsx` is a Radix `Dialog`, and the seeded workspace has 32
overdue accountability items, so it opens on load over the document editor. While it is open it both
covers the editor — `locator.click()` never passes hit-testing and dies as a bare 60s timeout with no
assertion — and traps focus, so `document.activeElement` can never become the editor. Observed
directly: three failed e2e runs before the dialog was identified. Any e2e test that drives the editor
after a direct `page.goto('/documents/:id')` has to dismiss it first; the new spec does. Derived, not
verified: this is a plausible contributor to the existing editor-spec flakiness in TEST-11 / TRO-233.

**New finding, not fixed here.** Building the test surfaced a real race in the server.
`wss.on('connection')` in `api/src/collaboration/index.ts` `await`s `getOrCreateDoc()` — a database
round trip — and registers `ws.on('message')` only afterwards. A client frame that arrives inside
that window has no listener and is dropped by the EventEmitter. A y-websocket client sends sync step
1 immediately on `open`, so on a low-latency link its step 1 is lost, the server never replies with
step 2, and **the client never receives the server's document state** — the editor stays empty while
the client's own state is pushed up. Observed deterministically on loopback (frames received were
`[3,0,1,1]`: cache-clear, the server's own step 1, two awareness updates, and no step 2). Derived,
not measured, for production: over a real network the client's step 1 normally arrives after the DB
read completes, so this reads as a dev/loopback defect — but the window is real and widens with
database latency. The test client works around it by sending its step 1 only after the server's first
frame, which is race-free because the server sends that frame in the same synchronous block that
attaches the listener.

**Roll back.** `git rm api/src/collaboration/__tests__/concurrent-merge.test.ts
e2e/concurrent-editing.spec.ts` and drop this entry. Nothing else on this branch touches product
code.

---

## TRO-277 — [TEST-12] Load-sensitive api flake: leaking mock queues and an unguarded shared test database

**What was broken.** The api suite failed an otherwise-good branch four times in one day, on a
different test each time, and passed on standalone re-run. `audit/factory/quarantine.json` records
api as `knownFailing: 0`, so each occurrence burned a gate attempt against the 3-retry cap. One
occurrence was on a branch touching only `web/` and `vite.config.ts`, which cannot break an api
DELETE test — so the cause was never in the ticket's diff. Two independent defects were found.

**Defect 1 — `vi.clearAllMocks()` does not drain queued once-values.** Confirmed on vitest 4.0.17:
`clearAllMocks` wipes call records but leaves unconsumed `mockResolvedValueOnce` responses queued.
A test that queues more responses than its handler consumes therefore leaves one behind, and the
next test receives that stale response first — shifting every subsequent mock in that test by one
and surfacing as a failure in an unrelated place. Five api test files combined the two.

**Defect 2 — nothing stopped two api suites from sharing one database.**
`api/src/test/setup.ts` `TRUNCATE`s 16 tables in the `beforeAll` of *every* api test file, and each
file then builds fixtures it depends on for the rest of the file. `fileParallelism: false` makes
that safe within one process and does nothing across processes. Two suites on one `DATABASE_URL`
delete each other's fixtures mid-file. Reproduced deliberately by running two suites against one
database: **18 and 20 failures**, dominated by `expected 401 to be 200` (the session row was
truncated away) and `violates foreign key constraint "documents_workspace_id_fkey"` in nested
`beforeAll` hooks — the exact shapes of all four recorded flakes.

**This also explains the phantom skips.** Two full runs had previously reported
`450 passed | 6 skipped (456)` with no `.skip`/`.todo`/`.fixme` marker anywhere in
`api/src/**/*.test.ts`. When a `beforeAll` hook fails, vitest reports that describe's tests as
**skipped, not failed** — an intermittently-absent assertion that reads as a pass. The two-suite
run reproduced it at scale: **11 and 33 skipped**, same zero markers.

**What changed.**

- `api/src/test/setup.ts` — takes a session-level Postgres advisory lock, held for the duration of
  each test file, before truncating. Concurrent suites now serialize at file granularity instead of
  corrupting each other; on timeout it fails with a message naming the cause rather than producing a
  mystery 401. Advisory lock spaces are per-database, so worktrees with their own database never
  contend, and the lock is released on disconnect so a crashed run cannot wedge the next one. The
  hook timeout is raised above the lock deadline deliberately: a hook that vitest abandons keeps
  running and would truncate outside vitest's control — that hole caused a residual failure in
  testing before it was closed.
- `api/src/routes/issues-history.test.ts`, `api/src/routes/iterations.test.ts`,
  `api/src/__tests__/activity.test.ts`, `api/src/__tests__/auth.test.ts`,
  `api/src/__tests__/transformIssueLinks.test.ts` — `resetAllMocks` in place of the clear-only
  variant. Mock factories in the first two were rewritten from `vi.fn().mockResolvedValue(x)` to
  `vi.fn(impl)`, because `resetAllMocks` restores an implementation passed to `vi.fn()` but wipes one
  chained on afterwards; a naive conversion would have turned those mocks into undefined-returning
  stubs. `issues-history.test.ts` also drops three now-redundant re-establishment lines, one of
  which was an `as any` cast.
- `api/src/__tests__/mock-isolation.test.ts` — new. Pins the four vitest semantics the fix rests on,
  and scans every api test file to fail the suite if the clear-plus-once-queue combination returns.

**Defect 3 — deadlines sized for an idle machine.** With the two mechanisms above fixed, 20 api runs
under concurrent build load still failed 6 times, and half of those failed on nothing but
`Test timed out in 5000ms` — on tests that take 10-70ms unloaded. A deadline 80x a test's normal
duration says nothing about correctness on an oversubscribed machine, and it cost a gate attempt each
time. Separately, `rate-limit.test.ts`'s 320-request burst was the single most frequent failure in
the suite, because `request(app)` binds a throwaway server per call and the burst created 320 of
them; it failed as `socket hang up` and as a 5s timeout.

- `api/vitest.config.ts` — `testTimeout` 5s → 15s, `hookTimeout` 10s → 30s. No assertion is raised or
  removed and nothing is skipped. The hook deadline is the more consequential one, because a hook
  that merely misses its deadline reports its describe's tests as *skipped* — silently dropping
  assertions instead of flagging anything.
- `api/src/middleware/__tests__/rate-limit.test.ts` — the burst binds one server for all 320
  requests, measuring the limiter instead of the ephemeral-port supply. The assertion is byte-for-byte
  unchanged: still 320 requests on one session key, still zero tolerated 429s.

**Evidence.** Red-before-green for the guard test: with two pre-fix files restored it fails with an
`AssertionError` naming `__tests__/activity.test.ts` and `routes/issues-history.test.ts`. Everything
else here is proven by repetition, since converting a mock-reset call has no meaningful unit test.

| Condition | Before | After |
|---|---|---|
| Two api suites, one database | 18 and 20 failures; 11 and 33 phantom skips | 1 failure in 950 tests; **0 skips** |
| 20 api runs under concurrent build load (load avg ~29 on 14 cores) | 6 runs failed | **1 run failed** |
| Phantom skips across those 20 runs | — | **0, in all 20** |
| `rate-limit.test.ts` alone, 25 runs under the same load | failed 3 times in 20 full runs | 25/25 |

**What is still broken, and is not fixed here.** Two residual failures remain, each seen once, and
neither is the mechanism above:

- `sprint-reviews.test.ts > POST /api/weeks/:id/review > returns 403 without auth (CSRF check first)`
  exceeded even the 15s deadline once in 20 runs — a hung request, not a slow one, so a larger
  deadline is not the answer.
- `workspaces.test.ts > POST /api/admin/workspaces > should return 403 for non-super-admin` returned
  **200** once in the two-suite run. An authorization assertion failing open deserves its own
  investigation on its own merits, separately from any flake question.

Both need their own ticket. Neither was reproduced twice, so no mechanism is claimed for either.

**How to run it.**

```bash
source .factory-env    # api tests TRUNCATE 16 tables; never run them without this

# The guard, and the four vitest semantics the fix rests on.
pnpm --filter @ship/api test --run src/__tests__/mock-isolation.test.ts

# Defect 2, directly: two suites against one database. Both must now pass.
# Before the lock they reported 18 and 20 failures, and 11 and 33 phantom skips.
pnpm --filter @ship/api test --run & (sleep 4; pnpm --filter @ship/api test --run); wait

# The repetition the flake actually needed: build load in parallel with the suite.
for i in 1 2 3 4; do (while :; do pnpm --filter @ship/api type-check; done >/dev/null 2>&1) & done
for n in $(seq 1 20); do pnpm --filter @ship/api test --run >/dev/null 2>&1 || echo "run $n FAILED"; done
kill %1 %2 %3 %4
```

**Rollback.** `git revert` the commits. The lock is confined to the test setup file and the
converted files are self-contained; nothing in `api/src` production code changed.

---

## TRO-181 (DB-4) + TRO-176 (API-5) — dashboard standups collapsed from one request per active week to one

Both findings are the same client-side fan-out seen from two sides — DB-4 from the SQL layer, API-5
from the HTTP layer — and share one fix.

**What was broken.** `web/src/pages/Dashboard.tsx:69-85` mapped the 5 active weeks returned by
`GET /api/weeks` to one `fetch('/api/weeks/${sprint.id}/standups')` each inside a `Promise.all` — 5
of the dashboard's 12 requests, each returning exactly 2 bytes (`[]`), and 25 of the flow's 42
steady-state queries (5x sprint access check, 5x standups `SELECT`, 5x the auth trio). The audit's
hypothesis held on direct inspection: the handler originally at `api/src/routes/weeks.ts:1833`
(now `:1927`, shifted down by the new route added above it) already batches issue-link lookups via
`batchLookupIssues` — the N+1 was entirely client-side, not a server defect. The per-week query also had no `LIMIT` and
shipped every standup's full `content`, though `Dashboard.tsx:92` immediately discarded everything
but the 10 most recent across all weeks.

**What changed.**

- `api/src/routes/weeks.ts` — new `GET /api/weeks/standups?week_ids=uuid,uuid,...`, registered
  *before* `GET /api/weeks/:id` so Express doesn't swallow `standups` as an `:id`. `week_ids` is
  validated with zod (`.split(',')` piped through `z.array(z.string().uuid()).min(1).max(50)`),
  rejecting anything malformed with **400** before it reaches SQL — the ids are only ever bound via
  parameterized `= ANY($1)`, never interpolated. One query narrows the requested ids to sprints that
  exist and are visible to the caller; one query fetches standups for all of them via
  `parent_id = ANY($1)`, `ORDER BY created_at DESC LIMIT 10` — server-side, so the endpoint stops
  shipping rows the client only ever discarded. Issue-link transformation reuses the existing
  `batchLookupIssues`/`transformIssueLinks` helpers, now batched once across every sprint's standups
  instead of once per sprint.
- `api/src/openapi/schemas/weeks.ts` — registered `GET /weeks/standups` (schema + zod, tags,
  summary/description) so Swagger and the generated MCP tool both pick it up.
- `web/src/hooks/useWeeksQuery.ts` — new `useRecentStandupsQuery(weekIds)`, one `react-query` call
  to the batched endpoint instead of the page doing its own fan-out.
- `web/src/pages/Dashboard.tsx` — replaced the `useState`/`useEffect`/`Promise.all` fan-out with
  `useRecentStandupsQuery`; `sprint_title`/`program_name` are now attached client-side from the
  already-fetched `activeWeeks` list (unchanged UI, unchanged `Standup` shape).
- The old `GET /api/weeks/:id/standups` route is untouched — nothing else that calls it (if
  anything does) is affected.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/weeks.test.ts -t "batched"
pnpm --filter @ship/web exec vitest run src/pages/Dashboard.standupsFanout.test.tsx src/pages/Dashboard.test.tsx
scripts/factory/gate.sh
```

The api tests assert the batched response shape, that a non-UUID or missing `week_ids` 400s, that
an unauthenticated call 401s, and that hitting the endpoint with 1 vs. 5 week ids costs the same
number of `pool.query` calls (spied directly — no query-count scaling with the number of weeks
requested). The web test does not mock `useWeeksQuery`; it lets the real hooks run against a mocked
`global.fetch` and asserts exactly one request matches `/api/weeks/standups`, and fails the test if
any request matches the old per-week shape.

**Measured, same seeded database (`ship_wt_tro_181`, postgres:15-alpine in the `ship-audit-pg`
Docker container on `:5433`), 5 active weeks x 1 standup each, one session, sequential requests, no
concurrent load from the measurement itself.** Because the old per-week route was left in place,
both sides were measured against the same running server rather than estimated: 5 sequential
`GET /api/weeks/:id/standups` calls (the old client behaviour) cost **5 requests / 30 queries**; one
`GET /api/weeks/standups` call for the same 5 ids costs **1 request / 6 queries** — an 80% cut in
both, for the standups portion of the flow specifically. The audit's own baseline (12 total dashboard
requests, 5 of them this fan-out; 42 total flow queries, 25 of them this fan-out) was not
re-measured end-to-end here — combining it with this delta (12 − 5 + 1 = 8 requests) reproduces the
audit's projected 8, which is a consistency check on the audit's number, not an independent
re-verification of the other 7 requests.

**Rollback.** Revert the commits on `fix/db-4-api-5-dashboard-fanout`. To roll back just the client
(keeping the server endpoint): revert the `Dashboard.tsx`/`useWeeksQuery.ts` changes only — the old
`GET /api/weeks/:id/standups` route still exists and still works. To remove the endpoint entirely:
delete the `router.get('/standups', ...)` block in `api/src/routes/weeks.ts` and its
`registry.registerPath` counterpart in `api/src/openapi/schemas/weeks.ts` — nothing else depends on
either.

---

## TRO-192 (ERR-5) + TRO-195 (ERR-8) — malformed path/query params returned 500 instead of 400/404

Both findings are one root cause: request **bodies** are validated up front with zod and return a
clean 400 (`createDocumentSchema.safeParse(req.body)` in `routes/documents.ts`), but path and query
params bypassed that layer entirely. `GET /api/documents/not-a-uuid` reached Postgres, failed an
`invalid input syntax for type uuid` cast, and surfaced as an uncaught 500
(`audit/error-handling/raw/probe3-api.txt`) — same for `GET /api/documents/:id/backlinks`,
`GET /api/weeks/:id`, and `?type=bogus` on the documents list (ERR-5). Separately, `?limit=-1` and
`?limit=999999999` on the documents list both returned the full ~300 KB payload, because the route
never read `limit` from the query at all (ERR-8).

**What changed.**

- **`api/src/middleware/paramValidation.ts` (new)** — the shared fix, extending the repo's existing
  body-validation pattern to params/query instead of inventing a new one:
  - `validateUuidParam` — an Express `router.param` callback. Registered once per router
    (`router.param('id', validateUuidParam)`), it guards **every** route using `:id` in that router
    against a malformed uuid, returning `{ error: 'Invalid input', details: [...] }` (the same shape
    body validation already used) instead of letting the pg cast error reach the client as a 500. A
    well-formed but nonexistent id is untouched and still falls through to the route's own 404.
  - `limitQuerySchema(max)` — a zod schema for an optional `limit` query param. Absent → unchanged
    behavior (no default cap introduced, so callers that never pass `limit` are unaffected).
    Non-numeric or non-positive (`-1`, `0`, `"abc"`) → fails validation (400). Above `max` → clamped
    down to `max` rather than rejected (ERR-8's "cap at a sane maximum").
- **`api/src/routes/documents.ts`** — `router.param('id', validateUuidParam)` guards `GET /:id`,
  `GET /:id/content`, `PATCH /:id/content`, `PATCH /:id`, `DELETE /:id`, `POST /:id/convert`,
  `POST /:id/undo-conversion`. `GET /` (list) gets a `listDocumentsQuerySchema` validating `type`
  against the full `document_type` Postgres enum (10 values, matching the already-registered
  OpenAPI `DocumentTypeSchema` — **not** the narrower 8-value set `createDocumentSchema` accepts for
  creation, since `standup`/`weekly_review` documents are created via their own routes but are real
  rows this filter already matched) and `limit` via `limitQuerySchema(100)`. When `limit` is
  provided, it is now applied as a real SQL `LIMIT`; `parent_id` handling is untouched.
- **`api/src/routes/backlinks.ts`** — `router.param('id', validateUuidParam)` guards
  `GET /:id/backlinks` and `POST /:id/links`.
- **`api/src/routes/weeks.ts`** — `router.param('id', validateUuidParam)` guards all 18 `:id` routes
  (`GET/PATCH/DELETE /:id`, `/:id/plan`, `/:id/issues`, `/:id/standups`, `/:id/review`,
  `/:id/carryover`, `/:id/approve-*`, `/:id/request-*-changes`, `/:id/scope-changes`, `/:id/start`).
  The probe's literal `GET /api/weeks/not-a-number` targets this same uuid path param — "number" was
  the malformed test string, not the field's real type.
- **`api/src/openapi/schemas/documents.ts`** — added `limit` to `GET /documents`'s documented query
  params and a `400` response, since that param is new. The `:id` uuid path params were already
  typed `UuidSchema` in every registration touched here (documents, backlinks, weeks) — the
  documented contract didn't change, only the runtime now enforces what was already promised.
  Regenerated `api/openapi.yaml` / `api/openapi.json` (additive only — `git diff --stat` shows +92/-0).

**Left alone on purpose.** `api/src/routes/issues.ts` has the identical `GET /:id` gap
(`GET /api/issues/not-a-uuid` also 500s per the probe) but was **not** touched: it has an open PR
against it right now, and both findings are fully covered by the routers above without it. Same
root cause, same fix (`router.param('id', validateUuidParam)`) would apply as a fast-follow.
`api/src/routes/associations.ts` (mounted at `/api/documents`) has the same `:id` gap and is outside
the audit's reproduced evidence — also not touched here.

**Frontend impact: none.** The only call site for `/api/documents?type=` sends `type=wiki`
(`web/src/hooks/useDocumentsQuery.ts:29`) — a valid enum value, still 200. No web code sends
`limit` to this endpoint, so the new validation and the `LIMIT` clause only activate for a query
string no current caller sends.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/param-validation-regression.test.ts
pnpm --filter @ship/api exec vitest run src/middleware/__tests__/paramValidation.test.ts
scripts/factory/gate.sh
```

`param-validation-regression.test.ts` hits the live routes via supertest (not the middleware in
isolation), covering both tickets: malformed uuid → 400 on `/api/documents/:id`,
`/api/documents/:id/backlinks`, and `/api/weeks/:id`; well-formed-but-absent uuid → 404 on the same
two GET-by-id routes (unaffected by this change); `?type=bogus` → 400 and `?type=wiki` → 200 on the
list; `?limit=-1`/`0`/`abc` → 400; `?limit=5` against 12 seeded documents → exactly 5 rows back
(proving the `LIMIT` is real, not just accepted); `?limit=999999999` → 200, no crash.
`paramValidation.test.ts` unit-tests the two helpers directly, including clamping against a small
`max` to prove the cap logic independent of the 100-row default.

**Rollback.** Revert the commits on `fix/err-5-err-8-param-validation`, or by hand: remove the three
`router.param('id', validateUuidParam)` lines (documents.ts, backlinks.ts, weeks.ts), remove
`listDocumentsQuerySchema`'s use in `documents.ts`'s `GET /` (restore the raw `req.query`
destructure and drop the `LIMIT` clause), delete `api/src/middleware/paramValidation.ts` and its
three imports, and revert the `limit`/`400` additions in
`api/src/openapi/schemas/documents.ts` (then re-run `pnpm --filter @ship/api openapi:generate`).

---

## TRO-197 (BUN-1) + TRO-198 (BUN-2) + TRO-199 (BUN-3) + TRO-200 (BUN-4) + TRO-202 (BUN-6) — the app stops shipping as one 2 MB file

Five findings, one root cause: `web/dist/index.html` referenced exactly **one** module script —
2,074.98 kB raw / 588.62 kB gzip — because nothing in the app split at a route boundary. Everything
else followed from that. There was no seam at which to defer the editor (BUN-2), the syntax
grammars (BUN-3) or the emoji picker (BUN-4), and no vendor chunk to cache (BUN-6). They ship as one
branch because fixing any one of them alone moves almost nothing.

**What a user actually downloads now**, by route. This is the static-import closure of the entry
chunk plus that route's chunk — not the `index.html` figure, which code splitting improves by
construction and therefore flatters any change of this kind:

| Route | Before | After | Change |
|---|---:|---:|---:|
| `/login` (unauthenticated first paint) | 601.47 kB gzip | **117.34 kB** | −484.13 (−80.5%) |
| `/docs` (4-panel layout + list) | 601.47 kB gzip | **181.92 kB** | −419.55 (−69.8%) |
| `/documents/:id` (layout + editor shell) | 601.47 kB gzip | **211.39 kB** | −390.08 (−64.9%) |

The audit's target was 600.75 → ≤ 480.60 kB gzip. Every route clears it. Total emitted bytes are
essentially unchanged (1,761.82 → 1,770.55 kB gzip, +0.5%) — as the audit predicted, this moves
bytes rather than deleting them, and total-bundle size is the wrong yardstick for it.

**The metric itself was corrected before these numbers were trusted.** The first version of
`audit/bundle/measure.mjs` derived each route's closure by walking `import "./x.js"` specifiers out
of the emitted chunks. That walk cannot see stylesheets, so CSS belonging to a lazy chunk was
omitted and every route read smaller than it is — the replacement for a flattering metric was
flattering in the same direction (CodeRabbit finding 1 on PR #14). It now reads
`dist/.vite/manifest.json` and follows `imports` while collecting `css` at every node, which is the
same graph Vite uses to emit modulepreload and stylesheet links.

Re-measured, the correction moves the numbers by **+0.05 kB gzip on `/login`, +0.02 on `/docs`,
+0.05 on `/documents/:id`** — the 80.5% headline stands. It is small for a specific reason worth
recording rather than glossing: this app's only lazy stylesheet is `assets/vendor-editor-*.css`
(1.41 kB raw / 0.53 kB gzip, the editor's Tippy styles), and it hangs off `vendor-editor`, which is
reachable only through the editor's dynamic import — so it was never inside any route's *static*
closure, and the entry stylesheet was already counted via the `index.html` `<link>`. The old method
was wrong; today's answer happened to be nearly right. The fix is what stops the next CSS-bearing
lazy chunk from going unmeasured silently.

**Conditions** (all figures): Node v23.2.0, pnpm 10.27.0, gzip level 9, kB = 1000 bytes, baseline
`main` at `4d74602`. Reproduce from the repository root:

```bash
cd web && pnpm build && cd .. && node audit/bundle/measure.mjs web/dist
# deploy churn also needs a previous dist to compare against:
#   node audit/bundle/measure.mjs web/dist --baseline /path/to/previous/dist
```

**Build from `web/`, not the repo root** — Tailwind's `content` globs resolve against the CWD, so
building from the root silently under-generates the CSS. The `cd ..` matters too: the script's paths
are relative to the repository root, so running it from `web/` cannot find `web/dist`.

The baseline was rebuilt from `main` in an isolated `git archive` copy rather than by mutating this
worktree, so every before/after pair comes from the same tool and the same machine.

**TRO-197 / BUN-1 — route-level code splitting** (`web/src/main.tsx`, `web/src/pages/App.tsx`,
`web/src/components/RouteFallback.tsx`). All 23 page components were statically imported, so a
visitor on `/login` downloaded the admin dashboard, the org chart, the reviews queue and the whole
TipTap/Yjs stack before the login form could paint. Every page is now `React.lazy`; most use named
exports, hence `.then(m => ({ default: m.X }))`. **`LoginPage` deliberately stays static** — it is
the first paint for an unauthenticated visitor, and deferring it would trade one oversized download
for two round trips before the form appears.

Two Suspense boundaries, and the placement is the whole risk: the outer one (in `main.tsx`) covers
the standalone routes and `AppLayout` itself; the inner one sits **inside `<main>` in
`pages/App.tsx`**, so the Icon Rail, Contextual Sidebar and Properties Sidebar stay mounted while a
page chunk loads. A single boundary above `AppLayout` would tear the 4-panel layout down and rebuild
it on every navigation — the flash the audit warned about.

Measured on its own (2, 3, 4 and 6 reverted on the final tree): /login 601.47 → 112.40 (−489.07),
/docs 601.47 → 176.86 (−424.61), /documents/:id 601.47 → 530.49 (−70.98) kB gzip.

**TRO-198 / BUN-2 — the editor loads when an editor is shown** (`web/src/components/LazyEditor.tsx`;
consumers `UnifiedEditor.tsx`, `pages/PersonEditor.tsx`). `@tiptap/*` + `prosemirror-*` + `yjs` +
`lib0` + `y-*` + `linkifyjs` are 726.5 kB raw / 208.7 kB gzip and were pulled statically by every
route that *could* show an editor — including project, program and week documents, which render a
tab component and never mount one. `LazyEditor` is **not a second editor**: it is the same shared
`components/Editor` behind a dynamic import, with the prop type derived from it so the contract
cannot drift.

Safe because `Editor` creates its own `Y.Doc`, `WebsocketProvider` and `IndexeddbPersistence` inside
its own effects and neither consumer holds a ref to it — deferring the mount defers the whole
collaboration setup as a unit rather than interleaving it. `initialTitle` is forwarded verbatim, so
the `"Untitled"` placeholder contract is untouched. Measured on its own (static import restored on
the final tree): **/documents/:id 442.95 → 211.39 kB gzip, −231.56**, the largest single win here.

**TRO-199 / BUN-3 — 37 syntax grammars down to 12** (`web/src/components/editor/lowlight.ts`,
`Editor.tsx:12`). `createLowlight(common)` registered arduino, vbnet, objectivec, r, lua, perl,
wasm and 30 others. Kept: **bash, css, diff, javascript, json, markdown, python, shell, sql,
typescript, xml (covers html), yaml**. Verified no seeded document is affected: zero of the 523
documents in the seeded database contain a `codeBlock` node (in `content` or in `yjs_state`), and
neither `api/src/db/seed.ts` nor `welcomeDocument.ts` emits one; the only language named anywhere in
the repo is `javascript`, in `e2e/syntax-highlighting.spec.ts`.

**Correction to what this entry first claimed.** It said a dropped language "renders as plain
monospace rather than throwing". That was inferred from a grep of the extension's guard, not from
running it, and it is wrong. Reading `getDecorations` in
`node_modules/@tiptap/extension-code-block-lowlight/dist/index.js` in full, the fallback is
`lowlight.highlightAuto(text)`, not "no highlighting":

```js
const nodes = language && (languages.includes(language) || registered(language) || lowlight.registered?.(language))
  ? getHighlightNodes(lowlight.highlight(language, text))
  : getHighlightNodes(lowlight.highlightAuto(text));
```

So a code block tagged `arduino` is **still highlighted**, by auto-detection among the grammars we
kept — observed, not derived: rendering that block through the real extension produces
`<span class="hljs-keyword">void</span>`. The degradation is better than reported, and the regression
risk of BUN-3 is correspondingly lower. Two further things that grep hid: `registered()` consults
highlight.js's *own* singleton bundled inside the extension, not our instance, so
`languages.includes()` off `lowlight.listLanguages()` is the check that actually carries our curated
list; and the author's `language-arduino` class is preserved on the `<code>` element, so re-adding a
grammar later restores exact highlighting. All three facts are now pinned by tests that drive
`CodeBlockLowlight` itself rather than the raw lowlight instance (CodeRabbit finding 2).

Measured on its own: the grammar chunk drops 52.22 → 22.56 kB gzip (−29.66), and total emitted bytes
fall 29.52 kB. It does not move any route's payload (211.38 vs 211.39 on `/documents/:id`, i.e. noise),
because BUN-2 already moved the editor off every route's static closure — BUN-3's win is in the chunk
that arrives when the editor mounts.

**TRO-200 / BUN-4 — the emoji picker loads on click** (`web/src/components/EmojiPickerBody.tsx`,
`EmojiPicker.tsx`). `emoji-picker-react` shipped on every page load, `/login` included, for one
consumer: the project-icon `PropertyRow` in `ProjectSidebar`. The package import now lives in its
own module — that, not the `React.lazy` call, is what creates the boundary; naming the package at
value level in `EmojiPicker.tsx` (for its `Theme` enum, say) would pull it all back while the code
still looked correct. The fallback is sized 300×350 so the popover does not resize under the cursor.
Measured on its own (static import restored on the final tree): **/documents/:id 274.75 → 211.39 kB
gzip, −63.36**, for a component behind a click.

**TRO-202 / BUN-6 — a vendor split, judged on bytes changed per deploy** (`web/vite.config.ts`).
The config had no `build` key at all, so stable dependency code shared a content hash with volatile
app source. **This does not reduce the initial payload — it costs about 5 kB gzip per route** — and
scoring it on `initialGzipKb` would read as a no-op or a regression. The right measurement is what a
returning user with a warm cache re-downloads after a routine deploy. Editing one string in
`web/src/pages/Login.tsx` and rebuilding:

| Route | Before | BUN-1..4 only | After (with BUN-6) |
|---|---:|---:|---:|
| `/login` | 588.61 kB gzip (97.9% of route) | 99.87 kB (88.9%) | **31.70 kB (27.0%)** |
| `/docs` | 588.61 kB gzip (97.9%) | 164.09 kB (92.8%) | **67.23 kB (37.0%)** |
| `/documents/:id` | 588.61 kB gzip (97.9%) | 193.13 kB (93.6%) | **96.31 kB (45.6%)** |

BUN-6's own contribution is the last column against the middle one: **−68.17 kB on `/login`, −96.86
on `/docs`, −96.82 on `/documents/:id`** per deploy, for +4.96 to +5.09 kB on a first visit
(/login 112.40 → 117.34, /docs 176.86 → 181.92, /documents/:id 206.30 → 211.39).

Two rules are encoded in the config and both were found by measuring, not by reasoning. **Never
merge a lazily-reachable package into an eagerly-reachable chunk** — a manual chunk loads as soon as
anything in it is statically reachable, so a catch-all `vendor` would have silently undone BUN-2 and
BUN-4 while the split still existed on disk. And **Rollup's CommonJS interop helpers must be pinned**:
left unassigned they landed in `vendor-highlight`, which every chunk then imported, dragging 22.6 kB
gzip of syntax grammars back into first paint. A `vendor-ui` group for Radix/cmdk/dnd-kit was tried
and **rejected on measurement** — it cost 15.0 kB gzip on `/docs` and `/documents/:id`, because a
route needing one primitive then downloads all of them.

**Build config also now emits a manifest.** `build.manifest: true` is what lets
`audit/bundle/measure.mjs` see the CSS graph. It ships `dist/.vite/manifest.json` to S3/CloudFront
with the rest of `dist`; it exposes chunk names, which are already enumerable from the entry chunk,
and no source paths beyond the module ids already present in the bundle. Keeping it on means the
build that is measured is the build that is deployed.

**New dependency:** `highlight.js` is now an explicit dependency of `@ship/web`. It was already in
the tree via `lowlight`, but importing individual grammars from it without declaring it would be a
phantom dependency. No new package entered the lockfile's resolution set.

**Regression tests** (all in `web/src/**`, so `scripts/factory/gate.sh` actually executes them — an
`e2e/` spec satisfies the gate's "test added" check while never running):

- `web/src/test/sourceImports.ts` + `sourceImports.test.ts` — **the guard behind the guards.** Three
  tests below assert that a module is never statically imported, which is the only thing keeping a
  split boundary from silently re-merging. Each originally carried its own narrow regex, and review
  found two of them (CodeRabbit findings 3 and 4) matched only the single form that was written at
  the time. Verified by injecting a static page import into `main.tsx` in seven forms — named with
  double quotes, default, namespace, multi-line braces, side-effect, relative path, re-export: **the
  old regex missed all seven; the shared detector catches all seven.** 30 tests cover the forms it
  claims to catch and the type-only/dynamic/commented forms it must ignore.
- `web/src/main.routes.test.ts` — no page may be statically imported except `Login`; every lazy
  loader names a real export; the child-route Suspense boundary stays inside `<main>`. **Red before
  the fix** (4 assertion failures against `main`'s `main.tsx`/`App.tsx`).
- `web/src/components/editor/lowlight.test.ts` — two blocks. The registry block asserts the grammar
  list is exactly the curated 12: **red before the fix** (9 assertion failures against
  `createLowlight(common)`). The integration block drives a real `Editor` with
  `CodeBlockLowlight.configure({ lowlight })` and asserts on rendered DOM, because nothing in the
  registry block proved the extension ever reaches our registry (CodeRabbit finding 2). Its
  discriminating case: for `+added line`, the `diff` grammar emits `hljs-addition` while
  auto-detection emits `hljs-selector-tag`, so a silent fall-through to `highlightAuto` fails the
  test where a language-class check would pass. It also pins that a dropped language does not throw
  and that the code survives byte-for-byte. Regression guard, not red-before-green — `common`
  contains those grammars too.
- `web/src/components/EmojiPicker.test.tsx` — picker opens on click, closes on Escape, clears
  through `onChange`, the package import stays out of `EmojiPicker.tsx` and stays in
  `EmojiPickerBody.tsx`. The import assertions were **red before the fix**; the interaction tests are
  regression guards and passed both ways, which is their purpose.
- `web/src/components/LazyEditor.test.tsx` — the editor still mounts, `"Untitled"` is forwarded
  verbatim, `documentId`/`roomPrefix` reach the editor unchanged, and the fallback is the panel
  variant. Regression guards.
- `web/src/components/RouteFallback.test.tsx` — the surrounding 4-panel chrome stays mounted while a
  lazy child resolves. Regression guard for the layout-flash risk.

**Rollback.** Per finding, in decreasing order of risk: revert `LazyEditor.tsx` and repoint
`UnifiedEditor.tsx`/`PersonEditor.tsx` at `@/components/Editor` (BUN-2); delete
`build.rollupOptions` and the `manualChunks` function in `web/vite.config.ts` — but **keep
`build.manifest: true`**, which is measurement infrastructure rather than part of BUN-6, and without
which `audit/bundle/measure.mjs` cannot run (BUN-6); restore `createLowlight(common)` in `Editor.tsx` and delete
`components/editor/lowlight.ts` (BUN-3); restore the static `emoji-picker-react` import in
`EmojiPicker.tsx` (BUN-4); replace the `React.lazy` declarations in `main.tsx` with static imports
and drop both Suspense boundaries (BUN-1). BUN-1 must be reverted last — the others depend on the
seam it creates.

**Still open, deliberately.** Vite still prints its >500 kB warning: `vendor-editor` is 577.5 kB raw.
The warning limit was *not* raised — silencing it would remove the only signal in the build about
this class of problem. BUN-5 (245 icon chunks, 209 unreferenced), BUN-7, BUN-8 and BUN-9 are
untouched and remain open.

**Found while measuring, not fixed here.** `web/tailwind.config.js` scans `./src/**/*.{js,ts,jsx,tsx}`,
which includes test files, so utility classes that exist only in a test inflate the shipped
stylesheet — the tests added by this branch grew `index-*.css` by 0.32 kB raw / 0.04 kB gzip. The fix
is to narrow the glob (e.g. exclude `*.test.*`), but `tailwind.config.js` was just modified by
TRO-217 and this is not the branch to contend for it. Filed rather than folded in.

---

## TRO-178 — [DB-1] `pnpm db:migrate` silently skipped 32 of 42 migrations and exited 0

**What was broken.** `api/src/db/migrate.ts:103-111` wrapped *both* the `schema.sql` application
and the migration loop in one `try`, and its handler matched any error message containing the
substring `already exists`. `010_oauth_state.sql:8` created `oauth_state` without `IF NOT EXISTS`
while `schema.sql:90` had already created it, so the migration threw `relation "oauth_state"
already exists` — indistinguishable, to that handler, from a benign `schema.sql` re-run. It logged
`Database schema already exists, continuing...`, returned normally, abandoned the remaining 32
files, and the process exited **0**. A second run behaved identically; it did not self-heal.

The report's hypothesis held exactly, including its list of the other blocking files.

**What changed.**

- `api/src/db/migrationRunner.ts` (new) — the migration logic, extracted from `migrate.ts` so it
  can be exercised by tests. `migrate.ts` is now the CLI wrapper: env, pool, exit code.
- The `already exists` tolerance now lives inside `applySchema` and covers only the `schema.sql`
  call, so a failure in the migration loop can no longer be mistaken for one. It matches Postgres
  SQLSTATE duplicate-object codes (`42P04`, `42P06`, `42P07`, `42701`, `42710`, `42723`) instead of
  a substring — substring matching on `already exists` would also swallow, for example, a failed
  `ALTER ... ADD CONSTRAINT` in a data migration.
- A failing migration is rethrown with its filename in the message, and `migrate.ts` exits 1.
- `applySchema` no longer swallows the duplicate-object error it tolerates — it **re-applies**
  `schema.sql` and lets the second attempt decide. `pool.query` sends the file as one simple query,
  so Postgres runs it as a single implicit transaction: an error at statement *k* rolls back
  statements 1..*k*-1 too, meaning nothing was applied. Returning normally there was DB-1 inside
  the DB-1 fix. A clean second pass proves every object exists (verified by the file itself, not by
  a hardcoded list that could drift); a second failure propagates and exits 1.
- Migrations `010`, `025`, `033`, `035` are now idempotent against the `schema.sql` end state
  (`IF NOT EXISTS`; a `pg_constraint` lookup for the CHECK constraint; `DROP TRIGGER IF EXISTS`
  before `CREATE TRIGGER`, the pattern `schema.sql:193` already uses; a `pg_enum`-guarded loop for
  the three `ALTER TYPE ... RENAME VALUE` statements). These four files are edited rather than
  superseded by a new migration, because a new migration cannot stop `010` itself from throwing,
  and databases that already recorded these versions never re-read them.
- Migration filenames are validated against `NNN_description.sql` — exactly three digits, an
  optional single letter (`007b_`, `014b_`, `015b_`, `018b_`, `020b_` all exist), then an
  underscore. The runner sorts the validated names **lexicographically**; that equals numeric
  order only because the pattern forces a zero-padded three-digit prefix, which is the whole
  reason the pattern is enforced. Anything outside it — an unnumbered `hotfix.sql`, or a
  four-digit `1000_` that would sort before `999_` — throws and names the offender before any
  migration is applied. The runner does not infer an order for such a file; it refuses to guess.
- Regression tests: `api/src/db/__tests__/migrationRunner.test.ts`.

**New ways `pnpm db:migrate` can now fail — all deliberate.** It previously exited 0 in every one
of these cases:

| Condition | Behaviour |
|---|---|
| any migration raises | exit 1, naming the file |
| migrations directory missing or unreadable | exit 1 |
| a `.sql` file there is not `NNN_description.sql` | exit 1, naming the offender |
| `033`: `document_type` has both `sprint_*` and `weekly_*` **and** documents still use the old label | exit 1 with the row count and the remedy |
| `033`: `document_type` has neither label of a pair | exit 1 |

The one state `033` deliberately tolerates is both labels present with **no** rows using the old
one — that is the normal outcome on a fresh database, because `schema.sql:100` declares the
post-rename labels and `017_standup_sprint_review_types.sql:14` then re-adds `sprint_review` via
`ADD VALUE IF NOT EXISTS`. Raising there would fail every fresh install.

**What the 32 previously-skipped migrations mean for an existing database.** Reported, not executed
against anything but a factory database — this is the part that needs an operator's eyes before the
next production deploy. Measured over `011`–`037` (31 files; `010` is the 32nd):

| | count |
|---|---|
| `ALTER TABLE` | 19 |
| of which `DROP COLUMN` | 3 |
| `CREATE TABLE` | 7 |
| `ALTER TYPE` | 4 |
| `UPDATE` / `INSERT` / `DELETE` statements | 27 / 8 / 3 |

`schema.sql` contains **zero** `ALTER TABLE` and **zero** DML, so on a database that already exists
these 31 files are the only mechanism that would ever have changed it. Notable: `027`/`029` drop
`documents.sprint_id`, `documents.project_id`, `documents.program_id`; `033` renames three
`document_type` enum labels `sprint_* → weekly_*` and rewrites matching `properties` JSON; `014b`,
`028` and `034` are backfills. **The first deploy after this change will apply all 32 at once.**
Take a snapshot first and run `pnpm db:migrate` against a restore of production before running it
against production.

**How to run it.**

```bash
source .factory-env                      # or otherwise point DATABASE_URL at the target
pnpm db:migrate                          # now exits non-zero on any migration failure
pnpm --filter @ship/api test src/db/__tests__/migrationRunner.test.ts
```

Verify with `select count(*) from schema_migrations;` — it should equal the number of `.sql` files
in `api/src/db/migrations/` (42 today), not 10.

**Verified** against PostgreSQL 15-alpine in the `ship-audit-pg` container on `:5433`:

- fresh database → 42 rows in `schema_migrations`, exit 0
- second run on it → clean no-op, still 42, exit 0
- `ship_wt_tro_178`, stuck at 10 rows (the state DB-1 had left it in) → 32 applied, 42 rows, exit 0
- a database seeded with the *pre-*`033` enum labels → renamed to `weekly_*`, 42 rows, exit 0
- both enum labels present plus one stale document → exit 1, naming the count and the remedy
- `document_type` missing both labels of a pair → exit 1
- applying `schema.sql` three times in a row against one database → no error any time, so the
  duplicate-object tolerance in `applySchema` is unreachable **sequentially** for the current file
  (17/17 `CREATE TABLE` and 59/59 `CREATE INDEX` guarded, both `CREATE TYPE`s in guarded `DO`
  blocks, function `OR REPLACE`, trigger preceded by `DROP TRIGGER IF EXISTS`)
- applying `schema.sql` from **6 connections at once** → 5 of 6 failed, so it is emphatically
  reachable **concurrently**: `CREATE TABLE IF NOT EXISTS` is check-then-create and not atomic.
  Mostly SQLSTATE 23505 on the catalog index `pg_type_typname_nsp_index`, sometimes 42710. 23505 is
  deliberately not tolerated; the concurrency defect itself is TRO-279
- `pnpm --filter @ship/api test` against the fully-migrated database → 475 tests passed

**Not verified.** No run against production or shadow, and no run against PostgreSQL 16 (production
runs pg16; CI and this work run pg15 — see the pin comment in `.github/workflows/ci.yml`). Proving
the production path needs a restore of a production snapshot.

**Rollback.** `git revert` the commits on `fix/db-1-migration-runner`, or, to restore only the old
runner behaviour, delete `api/src/db/migrationRunner.ts` and restore `api/src/db/migrate.ts` from
`main`. Rolling back the runner alone leaves migrations `010`/`025`/`033`/`035` idempotent, which is
harmless. Note that rollback does **not** un-apply migrations already recorded in
`schema_migrations`; reversing those requires a database restore.

---

## TRO-276 (ERR-10) — one malformed WebSocket frame no longer kills the API for everyone

**The user-facing cost.** Any authenticated user could send four bytes down a collaboration socket
and the entire API process died — every open editor in every workspace disconnected, every in-flight
request dropped, until the container restarted. It did not need malice: a truncated frame from a
flaky connection does it. Measured against a real running server, 5 of 7 malformed frames produced
an uncaught exception.

**Root cause.** `handleMessage()` in `api/src/collaboration/index.ts` decodes attacker-controlled
bytes with raw lib0 readers, which throw on truncated input. It was called from `ws.on('message')`
with no try/catch anywhere in the chain, and there was no `process.on('uncaughtException')` handler
in `api/`, `web/` or `shared/`. A `ws` 'message' listener is an I/O callback: a throw there escapes
to the process, and Node's default for an unhandled `uncaughtException` is to terminate.

**What changed.**

- `runFrameHandler()` wraps the **entire** body of both `ws.on('message')` handlers — the
  collaboration socket and the events socket. On a throw it logs structured context and closes that
  one socket with code **1002** (RFC 6455 protocol error). No other connection is affected. The
  whole body is guarded, not just the `handleMessage()` call, so the rate limiter and any future
  addition are covered too. It composes with the ERR-2 `revoked` check rather than duplicating it:
  the revocation short-circuit is now the first statement *inside* the guard, so a revoked socket is
  not even decoded. It also contains a **rejected promise**: `() => void` accepts an `async` function
  in TypeScript, so an async handler added later would reject after the `try/catch` had exited and
  escape as an unhandled rejection — ERR-10 again by the back door. A thenable result is routed
  through the same log-and-close path, and a test pins it.
- On the events channel the `catch` around `JSON.parse` no longer spans the response as well. It
  previously swallowed anything raised while replying, so an error there was discarded instead of
  reaching the guard's log-and-close path — a `catch {}` covering more than its comment claims is how
  a guarded handler quietly stops being guarded.
- `attachSocketErrorHandler()` covers a second vector of the same class. `ws` reports framing and
  transport failures by emitting `'error'` on the WebSocket, and `EventEmitter` throws an `'error'`
  event that has no listener — so a peer sending a frame with a reserved bit set crashed the process
  without ever reaching `handleMessage()`. It is attached as the **first statement** of the
  connection handler, before any `await`: that handler is `async` and loads the document from
  Postgres, and a frame arriving during that window found the socket unguarded. This was found by
  the regression test, against the first version of this fix. The events handler registers it first
  too — there, honestly, as defence in depth rather than a live fix: that handler is synchronous, and
  `ws.send()` with no callback does not emit `'error'` on a closed socket (`sendAfterClose` builds the
  error only `if (cb)`), so nothing could slip in ahead of a later registration. "Error listener
  first" is simply cheaper to hold as an invariant than to re-derive.
- `api/src/process-safety.ts` — `installProcessSafetyNet()`, wired in at `api/src/index.ts` only
  (the entrypoint, so importing the app never hijacks a test runner's error handling). It takes
  ownership of `uncaughtException` / `unhandledRejection`, logs full structured context, stops
  accepting new connections, and exits **1** after a bounded 5s drain.

**Why the safety net exits rather than continuing.** By the time it fires, the exception has escaped
every guard, so nothing is known about the state left behind — Node's own guidance is that resuming
is undefined behaviour. Continuing would trade a fast restart for an indefinitely, silently wrong
server. It is also not an availability regression, which is the decisive point: with no handler
installed, Node **already** terminates on an uncaught exception, and (since v15) on an unhandled
rejection too. This cannot make the process die more often than it does today. What it changes is
everything around the death — structured context instead of a bare stack, the listening socket
closed first, a bounded window for in-flight work, and a deliberate non-zero code for the supervisor
(`Dockerfile:75` runs `node dist/index.js` as the container command, so a non-zero exit is a
restart). The availability win comes entirely from the try/catch; the safety net only makes failures
legible.

One trap worth recording, because it already cost this project a ticket: **the stack trace lies.**
lib0 builds `errorUnexpectedEndOfArray` as a module-scope singleton `Error` whose stack is captured
at module *load*, so every one of these crashes points at whatever first imported lib0 rather than
at the throw site. Both the frame log and the fatal log therefore carry an explicit caveat on the
stack field, and the frame log identifies the input by other means.

**What the frame log does and does not contain.** It records frame *identity*, never frame content:
a truncated SHA-256 digest, the byte length, and the protocol message type. The first version of
this fix logged a 32-byte hex prefix of the frame, which was wrong — a frame that failed to decode
has usually been *partially* decoded, so its leading bytes can carry fragments of document text, and
logs get shipped, aggregated and retained. A digest preserves the property that matters for triage
(the same frame sent twice yields the same identity, so a repeated or automated attack is visible)
without the log holding the payload. Stated limit: for a very short frame the digest is reversible
by brute force, which is acceptable precisely because a four-byte frame cannot contain document
content, and the frames long enough to carry any are far too large to enumerate. The cost is that a
byte-exact replay can no longer be reconstructed from a log line; error name, length and message
type localize the failing decode path well enough to rebuild the frame by construction.

**How to run it.**

```bash
source .factory-env   # api tests TRUNCATE 16 tables; never run without this
pnpm --filter @ship/api exec vitest run src/collaboration/__tests__/malformed-frames.test.ts
pnpm --filter @ship/api exec vitest run src/__tests__/process-safety.test.ts
```

`malformed-frames.test.ts` drives the real collaboration server over real sockets with each frame
from the audit table plus a raw hand-rolled WebSocket frame with RSV1 set, and asserts that nothing
reaches the process level, that the offending socket is closed **with code 1002**, that a co-tenant
editor on the same document keeps working, and that new connections still persist edits afterwards.
It also pins the two frames that were always survivable (`[0,1]`, `[9,9,9]`) as still survivable, so
an over-broad fix that hangs up on legitimate traffic fails.

It contains **no fixed sleeps** (TEST-11 / TRO-233). Every wait is an observable: socket closures are
awaited as `'close'` events, and liveness is proved by pushing a write through a socket and reading
it back out of `documents`. The one polling helper reads the database until the row appears, because
`persistDocument()` is debounced inside the server and emits no external signal — it returns as soon
as the condition holds and the caller asserts on the value, so a timeout surfaces as a real
assertion about content rather than as "waited long enough". Each malformed frame gets its own fresh
attacker connection, so no case is ever asserting against a socket a previous case already closed.
`process-safety.test.ts` uses vitest fake timers, which is what lets it prove the *absence* of a
second exit after the drain window elapses.

Red before green, with `api/src/collaboration/index.ts` restored to the version on `main`:
**8 failed / 3 passed**, every failure a clean assertion — five naming the escaped exception
(`Unexpected end of array`, `Invalid typed array length: 5`), one naming
`Invalid WebSocket frame: RSV1 must be clear`, one `expected undefined to be 1002` for the missing
close-code constant, and one `expected false to be true` for the socket that was never closed. With
the fix: **12 passed** (the twelfth is the async-escape case, which has no unfixed counterpart —
verified red by removing only the thenable branch, giving
`unhandledRejection -> Error: async frame handler rejected`).

Note for anyone repeating that check: reverting with `git checkout HEAD -- <file>` stops working once
the fix is committed, because `HEAD` then *contains* the fix. Use `git show main:<file>`.

**How to roll it back.**

```bash
git revert <commit>   # or, per piece:
```

Reverting `api/src/process-safety.ts` plus its two lines in `api/src/index.ts` restores Node's
default crash behaviour without touching the frame guards — the guards are independent and are the
part that matters. Reverting `runFrameHandler` / `attachSocketErrorHandler` in
`api/src/collaboration/index.ts` restores the crash. No schema change, no migration, no config, no
API surface change; the only observable difference for a well-behaved client is that a client
sending undecodable bytes is now disconnected with close code 1002 instead of taking the server with
it.

---

## TRO-179 (DB-2) + TRO-177 (API-6) — authenticated reads stop rewriting the session row once per request

One statement, measured from two sides. `authMiddleware` ran
`UPDATE sessions SET last_activity = $1 WHERE id = $2` **unconditionally on every authenticated
request** (`api/src/middleware/auth.ts:205-208` on `main`), so a page that only *reads* still
produced one row-locking, WAL-generating write per request — and a single page load fires 5-13 of
them, all against the same row.

- **TRO-179 / DB-2 (SQL side):** three statements ran before any application data — a session+user
  SELECT, a workspace-membership SELECT, and the write. That was 16 of 17 queries on "List issues"
  and 34 of 51 on "Load sprint board". The write ran 121 times during capture and was the slowest
  statement in five of six flows (peak 4.764 ms) against an isolated EXPLAIN of 0.178 ms.
- **TRO-177 / API-6 (HTTP side):** `GET /api/documents/:id` returned ~2.2 KB from one indexed PK
  lookup yet cost P50 2.6 ms / P95 4.8 ms at c=10.

**What changed.** The fix was already written three lines below the bug: the sliding-cookie refresh
had always been throttled to once per 60s ("throttled to avoid overhead"); the same threshold was
simply never applied to the database write. Both halves of the sliding expiration now share one
throttle (`SESSION_ACTIVITY_UPDATE_THRESHOLD_MS`, 60s).

**Precisely what the throttle does and does not do.** Reads *within* the 60s window issue no write
at all. The first read *after* the window still refreshes `last_activity` — the sliding expiration is
intact, so a session in continuous use never expires. What is gone is the one-write-per-request
pattern, not the write.

**The throttle is enforced twice, and both placements are load-bearing.** The application-side check
uses the value the request already SELECTed, so when it says "not due" no statement is sent — that is
what removes the query from the hot path. But that value can already be stale: a page load fires 5-13
requests in parallel, and when the burst straddles the threshold they all read the same pre-write
`last_activity` and all conclude the write is due. So the predicate is repeated in SQL —
`UPDATE ... WHERE id = $2 AND last_activity < $3` — and Postgres arbitrates: under READ COMMITTED the
losers re-evaluate the qualification against the committed row version, fail it, and affect zero
rows. Measured below: without the SQL predicate a 10-request burst produced **10** row versions;
with it, **1**. Dropping either placement re-opens half the finding.

The expiry invariant survives the conditional write. A no-op leaves the row at its previous value,
and the UPDATE no-ops *only* when `last_activity >= now - threshold` failed the predicate — which is
exactly the bound the grace below assumes. In all three cases (application check skipped, write
applied, write no-opped) the stored `last_activity` is `>= requestTime - threshold`, so the lag is
still capped at one threshold. The conditional form is in fact strictly stronger: the unconditional
version could move `last_activity` *backwards* when two concurrent requests wrote timestamps captured
microseconds apart.

**Session expiry semantics — read this before changing the threshold.** Throttling the write means
the recorded `last_activity` trails real request activity by up to 60s. Comparing a lagging value
against a bare `SESSION_TIMEOUT_MS` would end sessions *early* — a user idle 14:01 could be logged
out of a 15-minute window. That is the unsafe direction, for two reasons:

1. The web client runs its own 15-minute idle timer off real user interaction
   (`web/src/hooks/useSessionTimeout.ts:295-305`) and does not heartbeat the server. A server window
   that can close before 15 minutes produces an unexplained 401 while the client still believes it
   is logged in.
2. The collaboration server reads `last_activity` on a 30s sweep and deliberately never refreshes it
   (see TRO-189 below). A tighter bound there would tear down the socket of a user whose REST
   requests are still being served — and the socket is where unsaved editor state lives.

So the enforced inactivity window is `SESSION_INACTIVITY_LIMIT_MS = SESSION_TIMEOUT_MS +
SESSION_ACTIVITY_UPDATE_THRESHOLD_MS` (16 min), applied identically by the REST middleware, the
refreshed cookie's `maxAge`, and the collaboration server's `isSessionRowValid()`. **True idle
logout now lands in [15:00, 16:00] instead of [14:00, 15:00]** — the rounding error extends a
session rather than ending one. The 12-hour absolute cap (`ABSOLUTE_SESSION_TIMEOUT_MS`) is
untouched, and 16 minutes remains well inside NIST SP 800-63B AAL2's 30-minute inactivity guidance.

**Measured** — `GET /api/documents/:id`, 12 sequential authenticated reads inside the throttle
window, `NODE_ENV=test`, vitest + supertest, concurrency 1, worktree PostgreSQL 15:

| | statements | per request | `last_activity` writes | auth share |
|---|---|---|---|---|
| before (`main`) | 60 | 5.00 | 12 | 60% |
| after | 48 | 4.00 | **0** | 50% |

20% fewer statements per read; the session-row write is gone from the hot path entirely. This is a
query-**count** measurement — the audit's c=10/c=50 latency numbers need a running server and a load
generator, and were not reproduced here.

**Measured, concurrent** — 10 parallel authenticated requests on one session parked 61s back, so the
whole burst straddles the threshold. Same conditions, plus a pre-warmed connection pool (a cold pool
serializes the burst and hides the effect entirely):

| | UPDATE statements | row versions written |
|---|---|---|
| application-side gate only | 10 | 10 |
| gate + SQL predicate | 10 | **1** |

The statement count is identical — all ten requests read the same stale row and all ten ask — but
only one row version, and therefore one row lock and one WAL record, results. Row-lock and WAL
contention on this single shared row is what the audit measured as the 0.178 ms → 4.764 ms gap.

**Files:** `api/src/middleware/auth.ts` (throttle + the two window constants),
`api/src/collaboration/index.ts` (mirrors the window).
**Tests:** `api/src/middleware/__tests__/session-activity-throttle.test.ts` (write skipped inside the
window, written after it, the SQL predicate's shape, and both expiry boundaries),
`api/src/middleware/__tests__/session-activity-race.test.ts` (one row version under a concurrent
burst), `api/src/routes/documents-query-count.test.ts` (statements per authenticated read).

**Rollback:** revert the commits on `fix/db-2-api-6-session-write`. No migration, no schema change,
no data change — sessions written under either version are interpreted correctly by the other.

---

## TRO-173 (API-2) + TRO-182 (DB-5) — the issue list stops shipping every issue's document body

Two findings, one cause, one change. API-2 measured it at the socket (`GET /api/issues` was the
slowest endpoint at every concurrency level and sent 379,907 bytes for 254 issues); DB-5 measured
the same thing in the planner (`width=1023` per row, against `width=300` for the `/api/documents`
projection that omits `content`). The list and detail views shared **one** SELECT projection
(`api/src/routes/issues.ts:126`, `content: row.content` at `:99`), so the list carried each issue's
full TipTap body, and there was no `LIMIT`/`OFFSET` anywhere in the file.

**Not a query problem.** The handler already batches associations in one `ANY($1)` query
(`api/src/utils/document-crud.ts:148-180`) — no N+1 — and the plan is a seq scan over 254 rows
costing ~142. The cost was `JSON.stringify` plus socket writes. No index was added; none was
missing.

**What changed.**

- `extractIssueFromRow` split into `extractIssueListItemFromRow` (shared fields) plus a thin
  `extractIssueFromRow` wrapper that adds `content` back. `GET /api/issues/:id`,
  `/by-ticket/:number` and `/:id/children` still return the body and are byte-identical.
- `d.content` removed from the list SELECT.
- `limit` (1-500) and `offset` (0-100,000) added to `GET /api/issues`. Both are bounded at both
  ends: unparseable, negative, fractional or over-maximum values get **400**, never silent
  truncation. `offset` is capped because an unbounded one is scanned and discarded inside Postgres —
  `OFFSET 1e9` buys a full scan that returns nothing.
- The route validates with `IssueListPaginationSchema` **imported from the OpenAPI schema module**,
  not a second copy, so the bounds Swagger advertises and the bounds the route enforces cannot
  drift.
- Both extractors take declared row types (`IssueListRow` / `IssueDetailRow`) instead of `any`. From
  PR review: an `any` *annotation* silences every field read, which on a projection extractor meant
  the exact thing this change touched — which columns the SELECT returns — was the one part not
  type-checked. Verified by introducing `row.titel` and getting
  `TS2551: Property 'titel' does not exist on type 'IssueListRow'`; under `any` that compiled.
  What it does not buy: TypeScript still cannot read the SQL string, so deleting a column from a
  query is not a compile error.

**The pagination contract, stated deliberately: there is NO default limit.** Omit both params and
you get every matching row, in the same order, exactly as before. That is not laziness — two
consumers read the response as a complete set, and a default limit would have returned *wrong*
lists rather than shorter ones:

- `web/src/hooks/useIssuesQuery.ts:137-143` filters by project **client-side** over the whole array
  (the API has no `project_id` filter — see the follow-up below).
- `web/src/components/IssuesList.tsx:310-330` groups, counts and merges the full array, including
  the "Show All Issues" path.

No web caller passes `limit` or `offset` today, so no existing caller changes behaviour. New
callers (and the generated MCP tool) can now bound a response; a caller knows it has the last page
when it receives fewer rows than it asked for.

**Contract change is registered with OpenAPI.** `GET /issues` now responds with a new
`IssueListItem` component — `Issue` minus `content` — and documents `limit`, `offset` and the 400.
`api/openapi.{json,yaml}` regenerated, so Swagger and the runtime-generated MCP tools describe the
shape the route actually returns. `Issue` (27 properties, with `content`) still backs the detail
paths.

**Evidence.** Same machine, same worktree, same deterministic dataset for every number below:
PostgreSQL 15-alpine in Docker (`ship-audit-pg`, `:5433`), API on `:3155` via `tsx watch` with
`NODE_ENV=development`, `pnpm db:seed` + `audit/seed-augment.ts` → **500 documents / 254 issues /
20 users** (the audit's volumes; the seed is fixed-seed so before and after ran against identical
bytes — `sum(pg_column_size(content))` = 158 kB / 64.5% of issue row bytes both times, matching
DB-5's figure). Before/after were measured by swapping only `api/src/routes/issues.ts`.

| | before | after | |
|---|---|---|---|
| `GET /api/issues` payload (254 issues) | 379,907 B | **241,338 B** | 1.57× smaller |
| `EXPLAIN` row width | `width=1023` | **`width=335`** | 3.05× narrower |
| p95 @ c=10 | 42.0 ms | **28.6 ms** | |
| p95 @ c=25 | 90.4 ms | **59.1 ms** | |
| p95 @ c=50 | 184.0 ms | **107.9 ms** | |
| p99 @ c=50 | 228.4 ms | **161.2 ms** | |
| throughput ceiling (Little's law) | ~311-325 rps | **~490-546 rps** | |
| `GET /api/issues?limit=50` | 379,907 B (ignored) | **47,608 B** | |
| `GET /api/issues/:id` | 1,802 B | 1,802 B | unchanged |

Latency: autocannon 8.0.0 installed into a session scratchpad (never into the repo), 600 requests
per level — a fixed request count rather than a duration, because
`api/src/middleware/rate-limit.ts:89` caps one session identity at 1000 requests / 60 s in
development. Each level logged in fresh for its own bucket; `non2xx=0, errors=0` on every level, so
no 429 is hiding in these numbers. Percentiles come from per-response latencies on autocannon's
`response` event. A second `after` run put p95 @ c=25 at 55.5 ms and @ c=50 at 110.2 ms, so read
these as ±5%. The `before` column reproduces the audit baseline (its c=25 p95 was 94.5 ms, c=50 p95
182.0 ms), which is the reason to trust the `after` column.

**Where the ticket's estimate was wrong.** TRO-173 predicted ~2.6× payload shrink and p95 @ c=25
falling to 35-40 ms. Actual: 1.57× and 59 ms. The estimate applied content's **database** share
(64.5% of row bytes) to the **JSON** payload, but in the response body `content` was only 146,015 of
379,907 bytes — **38.4%**. The other 25 fields carry per-row overhead (UUIDs, ISO timestamps,
repeated key names) that dominates at 254 rows. The mechanism held exactly; the magnitude did not.
The largest remaining component is now `belongs_to` at 80,900 bytes (**33.5%** of the response) —
association objects carrying `title` for every program/project/sprint/parent. That is the next
payload win on this endpoint and it has no ticket.

**How to run it.**

```bash
source .factory-env                                   # api tests TRUNCATE 16 tables
pnpm --filter @ship/api test -- src/routes/issues.test.ts
pnpm type-check
pnpm --filter @ship/api openapi:generate              # should be a no-op diff
```

**Roll back.** `git revert` the commits on `fix/api-2-db-5-issues-payload`. By hand: put
`d.content,` back in the list SELECT, call `extractIssueFromRow` instead of
`extractIssueListItemFromRow` in the list handler, drop `listPaginationSchema` and the
`LIMIT`/`OFFSET` block, restore `z.array(IssueResponseSchema)` on the `/issues` 200 response, and
regenerate the spec. The five new cases in `api/src/routes/issues.test.ts` fail if the body comes
back or pagination stops being honoured.

**Not verified.** Only api-tier tests and this endpoint were exercised — no browser pass confirms
the issues list still renders correctly against the narrower payload (it should: the web `Issue`
interface at `web/src/hooks/useIssuesQuery.ts:25-48` never declared `content`, and no `.tsx` reads
it off an issue). `/api/issues/:id/children` still returns `content` for sub-issues; it has the
same shape of waste, bounded by children per issue, and was left alone deliberately rather than
widening this change.

**Found, not fixed.** `web/src/components/sidebars/ProjectContextSidebar.tsx:148` requests
`/api/issues?project_id=<id>`, but the list route never reads `project_id` — the parameter is
silently ignored and that sidebar receives every issue in the workspace. Pre-existing, unrelated to
these two findings, and worth its own ticket.

---

## TRO-174 — [API-3] No response compression anywhere; the largest list payload shipped 15× larger than needed

**What was broken.** `api/src/app.ts` never registered any compression middleware, and
`compression` was not a dependency of `api/package.json`. Every JSON response went out
uncompressed even when the client explicitly advertised `Accept-Encoding: gzip`. `GET /api/issues`
was the worst case at **379,907 bytes**. On a 10 Mbps agency link that body alone is ~304 ms of
transfer time, paid by every user on every list load. The gap is invisible in local development
and in the api-perf benchmark because loopback transfer is effectively free — it only costs users
on a real WAN link.

**What changed.** `compression` is registered as the first middleware in `createApp()`, ahead of
every route, so all response bodies pass through it: API JSON, the Swagger UI, and the static SPA
on single-origin deployments.

Settings, and why:

- **`threshold: 1024`** — the library default, written out explicitly to document it. Below roughly
  one MTU there is nothing to win; gzip framing plus the CPU makes a small body marginally larger
  and slower. `/health` (15 bytes) is correctly left alone.
- **Compression level: zlib's default (6), not 9.** Measured on the real 379,907-byte body, level 9
  yields 24,091 bytes against level 6's 25,050 — **3.8% smaller for materially more CPU per
  response**, on a path that runs on every list request. Note this means the honest ratio is
  **15.17×**, not the 15.4× the audit projected from `gzip -9`.
- **Filter delegates to `compression.filter`**, which consults `mime-db` and so already declines
  already-compressed types — the images, PDFs and archives served by `/api/files/:id` keep their own
  encoding rather than being wastefully re-compressed. Three additions on top:
  - the conventional `x-no-compression` request opt-out;
  - a `text/event-stream` guard. There is no SSE endpoint in this codebase today (verified by grep
    for `text/event-stream` and `flushHeaders`, 2026-07-29); the guard is there because compression
    buffers, which would silently stall the first SSE endpoint someone adds. Note mime-db would
    happily compress `text/*`, so this guard is doing real work rather than restating the default.
  - an `application/octet-stream` guard. mime-db reports octet-stream as **compressible**, but it is
    the "unknown binary" fallback, and the one route that emits it is `GET /api/files/:id`, which
    echoes a client-declared `mime_type` verbatim (`files.ts:309`) for an upload validated only
    against a filename extension blocklist (`files.ts:80-84` — any mime string is accepted).
    Speculatively gzipping an arbitrary, likely already-compressed user binary on every download
    costs CPU for no benefit.

  Both guards compare against a **lower-cased** media type. RFC 9110 §8.3.1 makes media types
  case-insensitive, so `Text/Event-Stream` and `Application/Octet-Stream` are legitimate headers.
  A case-sensitive comparison would defeat both guards silently, and for octet-stream the bypass
  would be **client-controlled** — the same client-declared `mime_type` that reaches
  `files.ts:309` would decide whether the guard applied to its own download. Caught in PR review;
  see the exclusion tests below.

  **`compression.filter`'s own mime-db lookup is already case-insensitive** — verified against a
  real server: `Application/JSON` and `APPLICATION/JSON` compress exactly as `application/json`
  does, `Image/PNG` and `Application/PDF` pass through exactly as their lower-case forms do, and
  a `; Charset=UTF-8` parameter changes nothing. **So normalisation belongs only in the two
  additions above — do not add it to the library path.** Recorded here because the natural
  "fix" for a case bug is to normalise everywhere, and here that would be wasted work.

  The Yjs collaboration WebSocket is unaffected — `ws` handles the upgrade off the HTTP response
  path, so this middleware never sees it.

  Filter behaviour was verified against a real HTTP server using the exact filter from `app.ts`,
  across 22 content types. Compressed: `application/json`, `text/html`, `application/javascript`,
  `text/css`, `text/csv`, `text/plain`, `application/xml`, `image/svg+xml`. Passed through:
  `image/png`, `image/jpeg`, `image/webp`, `application/pdf`, `application/zip`, `application/gzip`,
  `application/x-7z-compressed`, `video/mp4`, the four Office formats (docx/xlsx/doc/xls), plus the
  two guarded types above. **That 22-type matrix was run lower-case only, and is manual
  verification, not automated coverage** — mime-db's own behaviour is the library's business. The
  two guards this change adds are a different matter: they are safety guards with a client-reachable
  input, so they now have assertions (11 cases, mixed-case included) rather than a hand-run matrix.

**⚠️ DO NOT "DISPROVE" THIS FIX WITH A LOCALHOST BENCHMARK.** Enabling gzip does **not** reduce P95
over loopback and may raise it slightly. Localhost transfer time is ~0, so the only thing a local
benchmark can measure is the compression CPU that was added. A compare-mode `/api-perf-audit` run
against `audit-baseline` will therefore show this fix as **flat or marginally worse**, and that
result is not evidence against it. This is a bytes-on-the-wire fix: validate it by **payload size**,
or over a **bandwidth-shaped link**. This is standing rule 13 in the factory lessons, and it exists
because of this exact finding.

**Evidence — payload bytes, not loopback timing.** Local Express server (`tsx api/src/index.ts`,
port 3154, `NODE_ENV` unset i.e. development) against PostgreSQL 15 in Docker `ship-audit-pg` on
`:5433`, database `ship_wt_tro_174`, seeded with `pnpm db:seed` followed by `audit/seed-augment.ts`
to the volumes in `audit/shipshape.config.yaml` — 500 documents (254 of them issues) / 20 users.
Bytes counted by `curl -w '%{size_download}'`, which does not decompress when `Accept-Encoding` is
set by hand. The "before" column is the same server answering `Accept-Encoding: identity`; that is
byte-for-byte what the pre-fix code returned regardless of request headers, and it is independently
confirmed by the `x-no-compression` opt-out returning the identical 379,907.

| endpoint | before (identity) | after (gzip, level 6) | reduction |
|---|---|---|---|
| `GET /api/issues` | 379,907 B | **25,050 B** | **15.17× / −93.4%** |
| `GET /api/documents` | 293,822 B | **28,227 B** | 10.41× / −90.4% |
| `GET /api/openapi.json` | — | 18,039 B | compressed |
| `GET /health` (15 B) | 15 B | 15 B | under threshold, untouched |

The 379,907-byte "before" figure reproduces `audit/AUDIT_REPORT.md`'s number **exactly**, which
confirms the dataset here is byte-identical to the one the finding was measured against.

Transfer time at 10 Mbps is **derived arithmetic from those measured byte counts, not an observed
WAN measurement**: 379,907 B → ~304 ms, 25,050 B → ~20 ms, a saving of ~284 ms per issue-list load.

**Interaction with TRO-173/TRO-182 — do not double-count.** That branch removes `content` from the
`/api/issues` list projection, shrinking the same payload. Measured on the identity body from this
branch, the `content` field is **36.5%** of those 379,907 bytes. The two fixes compose, and the
honest attribution is:

| | identity | gzip level 6 | compression's own factor |
|---|---|---|---|
| this branch (`content` present) | 379,907 B | 25,050 B | **15.17×** |
| after TRO-173 (`content` stripped) | 241,338 B | 19,894 B | **12.13×** |

So compression alone is worth 15.17× today and still 12.13× once TRO-173 lands; the *combined*
379,907 → 19,894 is **19.10×** and belongs to both tickets, not to either one. Neither ticket
should claim it alone.

**CloudFront in the deployed stack — does it already do this?** Partly answered from config, and
the answer is "no, and the win is not double-counted" — but the deployed-stack half is **derived
from Terraform, not observed against the live distribution**.

*Observed in the repo:* the `/api/*` cache behaviour does set `compress = true`
(`terraform/s3-cloudfront.tf:154`, `terraform/modules/cloudfront-s3/main.tf:172`), and all three
environments (dev/prod/shadow) use `modules/cloudfront-s3`. But that behaviour attaches
`aws_cloudfront_cache_policy.api_no_cache`, whose
`parameters_in_cache_key_and_forwarded_to_origin` block sets `header_behavior = "none"` and sets
**neither `enable_accept_encoding_gzip` nor `enable_accept_encoding_brotli`** — a repo-wide grep for
`enable_accept_encoding` returns no matches at all.

*Derived from AWS's documented behaviour:* CloudFront automatic compression requires the attached
cache policy to enable Accept-Encoding gzip/Brotli support; with both unset (Terraform default
`false`), `compress = true` is inert. So `/api/*` was very likely **not** being compressed at the
edge, and the 15.17× measured here is a real production win rather than a re-count of something
CloudFront was already doing. The fix is also robust either way: the origin request policy uses
`header_behavior = "allViewerAndWhitelistCloudFront"`, so the viewer's `Accept-Encoding` does reach
Express, and CloudFront relays an origin response that already carries `Content-Encoding: gzip`
without re-compressing it.

*Unverified:* no `curl` was run against `https://ship.awsdev.treasury.gov` to observe an actual
`Content-Encoding` header on a deployed response. The deployed-stack claim above rests on config
plus documented behaviour only.

**Regression test.** `api/src/routes/compression.test.ts` — 17 cases, in a vitest file the gate
actually executes (an `e2e/*.spec.ts` would satisfy the gate's added-test grep while never running).

Three integration cases over the real app via supertest: `Content-Encoding: gzip` appears on
`/api/issues` when the client advertises gzip, does **not** appear when the client sends
`Accept-Encoding: identity`, and does not appear on a sub-threshold response. Each also asserts the
decoded body is intact, because a `Content-Encoding` header over a corrupted body would otherwise
read as a pass.

Fourteen unit cases over `isCompressionExcluded`, exported from `app.ts` as a test seam: both
guarded types in four case variants each, the `x-no-compression` opt-out, ordinary compressible
types (which must fall *through* to mime-db, so over-excluding would lose the whole fix), absent /
numeric / array `Content-Type` values, and three decoy-parameter cases (below).

**Review fix — media type must be matched by equality, not substring.** CodeRabbit's review of PR
#20 caught that the exclusion check compared the excluded media types against the **whole**
`Content-Type` header via `.includes()`, parameters and all. A value like
`text/plain; note="application/octet-stream"` is genuinely `text/plain` and should compress, but the
old check saw `application/octet-stream` inside the parameter text and wrongly excluded it —
matching the parameter, not the media type. Fixed by splitting on the first `;`, trimming, and
comparing the resulting media type by exact equality (mirrored per-element for array `Content-Type`
values, since Express can in principle return one). Three new cases cover it: a `text/plain` decoy
mentioning `application/octet-stream`, an `application/json` decoy mentioning `text/event-stream`,
and — the mirror case, so the fix isn't just "never exclude anything" — a genuine
`application/octet-stream` that also carries parameters, which must still be excluded. Confirmed red
first: against the substring-matching code, the two decoy cases failed with
`AssertionError: expected true to be false` (the decoy in the parameters was wrongly triggering
exclusion), while the genuine-octet-stream-with-parameters case already passed — proof the two new
assertions were exercising the actual bug and not some unrelated setup problem.

One deliberate design choice: the negative case additionally asserts the uncompressed
`Content-Length` **exceeds** the 1024-byte threshold, with an actionable failure message. If a
future payload reduction takes `/api/issues` under the threshold, the gzip assertion would start
passing for the wrong reason — nothing to compress rather than compression working. The test fails
loudly instead. The seeded payload is padded via long **titles**, not `content`, precisely so
TRO-173 removing `content` cannot make it vacuous.

Confirmed red first, twice. With the middleware absent the gzip case failed with
`AssertionError: expected undefined to be 'gzip'` at the `content-encoding` assertion — the right
reason, not an import or setup error — while the other two cases passed. Then the case-insensitivity
fix was driven the same way: against the case-sensitive comparison, exactly the six mixed-case
assertions failed with `AssertionError: expected false to be true` while all four lower-case cases
passed, which is what proves the refactor that introduced the seam changed no behaviour on its own.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api exec vitest run src/routes/compression.test.ts

# Reproduce the payload measurement (NOT a latency benchmark — see the warning above).
pnpm --filter @ship/api db:seed && api/node_modules/.bin/tsx audit/seed-augment.ts
PORT=3154 api/node_modules/.bin/tsx api/src/index.ts &
# then, with a valid session cookie for a seeded user:
curl -s -o /dev/null -H "Cookie: session_id=$SID" -H 'Accept-Encoding: identity' \
  http://localhost:3154/api/issues -w 'identity=%{size_download}\n'
curl -s -o /dev/null -H "Cookie: session_id=$SID" -H 'Accept-Encoding: gzip' \
  http://localhost:3154/api/issues -w 'gzip=%{size_download}\n'
```

Setting `Accept-Encoding` by hand matters: `curl --compressed` would decompress transparently and
report the identity size for both, hiding the entire effect.

**Rollback.** Delete the `app.use(compression({...}))` block and the `import compression` line from
`api/src/app.ts`; optionally drop `compression` and `@types/compression` from `api/package.json`.
Deleting `api/src/routes/compression.test.ts` reverts the test. No schema, route, or API-contract
change; nothing to migrate.

**Found, not fixed.** The inert `compress = true` on the `/api/*` CloudFront behaviour is a latent
config inconsistency worth its own ticket: enabling `enable_accept_encoding_gzip` on the
`api_no_cache` cache policy would make the edge setting mean what it appears to mean. It is a
Terraform change, out of scope here, and origin-side compression is the more robust fix anyway
because it also covers single-origin deployments and direct-to-Elastic-Beanstalk access, which do
not pass through CloudFront at all.

---

## TRO-224 — [TEST-2] 68 e2e tests could pass without executing a single assertion

**What was broken.** A brace-scan of 866 static test blocks found **3 tests with no `expect()` at
all** and **65 whose every `expect()` sat inside a conditional** — 7.9% of the suite reporting
success while observing nothing (`audit/test-quality/runs/e2e-vacuous-tests.txt`). Two of them were
the only automated coverage of a security control:

- `security.spec.ts:217` *XSS via data: URI in links* typed `[Click](data:text/html,…)` into a new
  document, then looped over `editor.locator('a')` asserting only inside
  `if (href?.startsWith('data:'))`. **TipTap ships no markdown-link input rule**, so the typed text
  stayed literal, zero `<a>` elements existed, and the loop body never ran. Its sibling *XSS via
  markdown link injection* (`:197`) had the same hole without the `if`. Neither could tell "the app
  sanitised the URI" from "the app rendered nothing" — and the truth was the latter, for the whole
  life of both tests.
- `authorization.spec.ts:299` *workspace member cannot view workspace audit logs* buried
  `expect(response.status()).toBe(403)` inside `if (wsResponse.status() === 200)` inside
  `if (workspaceId)`. Any hiccup fetching `/api/workspaces/current` skipped the entire authorization
  check silently.

The guards had been added to stop tests failing on missing seed data — the same failure mode
`.claude/CLAUDE.md` already forbids for `test.skip()`. The rule was written for `test.skip()` and
never extended to `if`, so the practice migrated instead of stopping.

**What changed.** Nine vacuous tests rewritten, three new tests added, and — because
`gate.sh` runs neither vitest project over `e2e/` — the two security properties were **also** pinned
in tiers the gate executes.

*Security, non-negotiable (both proven red-first — see Evidence):*

- `web/src/components/editor/linkOptions.ts` **(new)** — the app's link-href policy, named and
  exported: `protocols: []` plus an explicit `isAllowedUri` that denies
  `javascript`/`data`/`vbscript`/`file`/`blob` after `defaultValidate`. Behaviourally a **no-op
  today**: `@tiptap/extension-link` 2.27.2 already rejects all five in its default `isAllowedUri`
  and strips the `href` during `renderHTML`. The point is that the protection was *inherited
  silently* — adding a scheme to `protocols`, or overriding `isAllowedUri`, would have removed it
  with no test failing anywhere. Wired into `web/src/components/Editor.tsx:588` and all three
  `Link.configure` calls in `web/src/components/StandupFeed.tsx`.
- `web/src/components/editor/linkOptions.test.ts` **(new, 27 cases, runs in the gate)** — content
  loaded as TipTap **JSON**, which is the stored-XSS path (`Mark.fromJSON` does not run
  `parseHTML`'s href guard). Asserts a benign `https` href survives *and* that
  `javascript:` / `data:text/html` / `data:image/svg+xml` do not, plus scheme-obfuscation cases
  (`jav\tascript:`, `java\nscript:`, `j a v a s c r i p t:`).
- `api/src/routes/workspaces.test.ts` — three cases added beside the existing member→403 check: the
  403 body must not carry `"logs"`, an unauthenticated request is refused, and a member is refused
  the audit log of a workspace they are not a member of.
- `e2e/security.spec.ts` — the two link tests are replaced by *stored dangerous link hrefs are not
  rendered live*, which opens a seeded document whose `content` already holds link marks with
  dangerous hrefs and asserts unconditionally; plus *markdown link syntax does not create a link at
  all*, which pins the fact the old tests were unknowingly relying on, so that adding a
  markdown-link input rule later fails loudly instead of silently re-opening the vector.
- `e2e/authorization.spec.ts` — every precondition is its own assertion with an actionable message,
  so a setup failure now fails *as a setup failure*; plus a companion test for a foreign workspace's
  audit log.

*The rest, working outward from security:*

| file | test | was |
|---|---|---|
| `e2e/file-attachments.spec.ts:161` | should validate file type | **0 `expect()`** — uploaded a `.exe`, slept 1 s, listed three acceptable outcomes in a comment. Now asserts the blocked-file dialog fired, that **no request reached `/api/files`** (the bytes never leave the browser), and that no attachment node was inserted. |
| `e2e/file-attachments.spec.ts:422` | should block dangerous executable files (.exe) | assertions lived *inside* `page.on('dialog')`, so they never ran if the dialog never fired. Messages are collected and asserted outside the handler. |
| `e2e/check-aria.spec.ts` | check aria-expanded elements | **0 `expect()`** — a diagnostic script with 19 `console.log`s and `return`-on-missing-data. Now asserts the A11Y-1 contract: `aria-expanded` sits on a real `<button>`, is named, and (new second test) tracks the children and survives navigating into one. |
| `e2e/accessibility-remediation.spec.ts:1398` | code blocks have language indication | **0 `expect()`** — ran on `/docs`, which renders no code block, and discarded the computed result. Now opens a seeded document with one code block and asserts count **and** language. |
| `e2e/admin-workspace-members.spec.ts:87` | can change member role | whole body inside `if (await roleSelect.isVisible())`. Now asserts the seeded member row exists, and reloads to prove the PATCH reached the server rather than only moving a local `<select>`. |

**Fixture work, never a conditional skip.** `e2e/fixtures/isolated-env.ts` gains
`seedRenderingFixtures()`: a *Link Sanitization Fixture* document (one benign control href + three
dangerous ones stored as link marks) and a *Code Block Fixture* document (one code block with
`language: 'javascript'`). Both are seeded at `position` 90/91 so they sort last and never become
the document `/docs` auto-opens. Titles and hrefs are exported as constants so a rename cannot
orphan a spec. `e2e/fixtures/test-helpers.ts` gains `openFixtureDocument(page, title)`, which
resolves the id through `GET /api/documents` and asserts the fixture exists with an actionable
message.

**The positive control is the mechanism.** Every rewritten test that inspects rendered elements now
asserts *first* that the thing it will inspect is present. Without that, "the page rendered nothing"
is indistinguishable from "the check passed", which is exactly what 68 tests were doing.

**Evidence.** Red-before-green, both security properties, under `pnpm --filter @ship/{web,api} exec
vitest run <file>` against the branch's own worktree database
(`postgresql://…@localhost:5433/ship_wt_tro_224`):

| deliberate break | result |
|---|---|
| `linkOptions.ts` → `isAllowedUri: () => true` + `protocols: ['javascript','data']` | **4 failed / 23 passed.** `AssertionError: javascript: must not survive into a rendered href`, same for `data:text/html` and `data:image/svg+xml`, plus `"javascript" must never be an allowed link protocol`. The benign-control case stayed **green**, which is what shows the failure is the vulnerability and not a broken test. |
| `workspaces.ts:1021` → `workspaceAdminMiddleware` removed from `GET /:id/audit-logs` | **3 failed / 25 passed**, each `expected 200 to be 403`. Includes the foreign-workspace case, i.e. without the middleware the handler itself does no scoping. |
| both reverted | 27/27 and 28/28 pass. |

**Gate result, and how it got there.** Before this branch merged `main`, `scripts/factory/gate.sh`
reported `tests:not-weakened FAIL — 6 removed test/assertion line(s)`. That check counted removed
`expect(` lines with no comparison to added ones, so it could not distinguish deleting an assertion
from *replacing a vacuous one*. All six removed lines were the vacuous assertions this ticket exists
to delete:

```
e2e/authorization.spec.ts    expect(response.status()).toBe(403)        # was inside two nested ifs
e2e/file-attachments.spec.ts expect(dialog.message()).toContain('.exe')      # was inside page.on('dialog')
e2e/file-attachments.spec.ts expect(dialog.message()).toContain('blocked')   # was inside page.on('dialog')
e2e/security.spec.ts         expect(href).not.toContain('javascript:')       # was inside a loop over 0 elements
e2e/security.spec.ts         expect(href).not.toContain('text/html')         # was inside `if (href?.startsWith('data:'))`
e2e/security.spec.ts         expect(href).not.toContain('<script')           # was inside `if (href?.startsWith('data:'))`
```

Each is replaced by a stronger unconditional assertion in the same test; `regression-test` reports 13
added cases. After merging `main` (`86b5231`), `gate.sh`'s G5 had independently been changed to a net
comparison of removed vs. added test lines — motivated by this exact false-positive class on other
tickets (TRO-223, TRO-179) — and now reports `tests:not-weakened PASS — -6 / +51 test line(s) — net
gain, reviewer should confirm the removals are corrections`. No edit to `gate.sh` was made on this
branch; the fix landed on `main` independently and this entry is corrected to match the gate this PR
actually merges against. Every other gate is green, including `review-patterns` (G7b, also new from
`main`) and both vitest projects.

Three separate gate runs have each failed `tests:api` on a *different* untouched test
(`backlinks.test.ts`, `rate-limit.test.ts`, then `weeks.test.ts`'s "should reject review approval
without rating"); all three pass standalone and the full api suite is 472/472 each time — that is
TRO-277's load-sensitive flake (documented to appear under CPU load, right after `type-check` +
`build`), not this branch.

**Attempted, then reverted — and it found two bugs.** `e2e/ai-analysis-api.spec.ts:209`
*"POST /api/ai/analyze-plan returns 429 after 10 rapid requests"* guards its assertions with
`if (!allSucceeded)`, so the single outcome it exists to catch — the limiter doing nothing — is the
one outcome it excuses. Making the assertion unconditional produced, **observed**,
`Got: 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200` — eleven admissions, no `429`. Two
findings fall out, neither of them a test bug:

1. **The test's premise is false.** `api/src/services/ai-analysis.ts:39` sets `RATE_LIMIT = 120`
   per hour, not 10. Eleven requests cannot trip it, and never could.
2. **The user is told the wrong number.** `api/src/routes/ai.ts:34` returns *"Rate limit exceeded.
   Max 10 analysis requests per hour."* while 120 is enforced. Whoever hits the ceiling is given a
   figure off by 12×.

The file is reverted to its original state. Asserting truthfully would need 121 requests — 120 of
which each attempt a Bedrock call and would likely blow the 60 s test timeout — or making the limit
injectable, which is a production change to enable a test. Neither belongs in a test-integrity
ticket. The 10-vs-120 inconsistency needs its own ticket; the vacuous guard stays on the TEST-2 list
until it does.

**Not done, deliberately.** 60 of the 68 remain. `program-mode-week-ux.spec.ts` alone holds 33
(sprint-filter and quick-menu UX, no security content); `accessibility-remediation.spec.ts` has 6
more, `context-menus.spec.ts` 6, `features-real.spec.ts` 5, `performance.spec.ts` 2, and
`ai-analysis-api.spec.ts` keeps 1 (see above), and
`admin-workspace-members.spec.ts` keeps 2 (`selecting user from search…`, `can add existing user…`)
which are guarded on a **"test space" workspace and a "carol" user that the isolated fixture does
not create** — converting those guards needs a second seeded workspace and more users, which risks
the workspace-switcher and admin-dashboard specs and belongs in its own ticket. See TRO-225's entry
for the retries decision.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database

# The tiers the factory gate actually executes
pnpm --filter @ship/web exec vitest run src/components/editor/linkOptions.test.ts   # 27 pass
pnpm --filter @ship/api exec vitest run src/routes/workspaces.test.ts               # 28 pass

# The e2e specs, targeted. Never the whole suite: 600+ tests, per-worker containers.
pnpm exec playwright test e2e/security.spec.ts       --workers=1 --retries=0        # 18 pass
pnpm exec playwright test e2e/authorization.spec.ts  --workers=2 --retries=0        # 18 pass
pnpm exec playwright test e2e/file-attachments.spec.ts --workers=2 --retries=0      # 13 pass
pnpm exec playwright test e2e/check-aria.spec.ts e2e/admin-workspace-members.spec.ts --workers=2 --retries=0
pnpm exec playwright test e2e/accessibility-remediation.spec.ts --workers=2 --retries=0 \
  -g "code blocks have language indication"                                          # 1 pass
```

To see the security tests fail, reintroduce the vulnerability: set
`isAllowedUri: () => true` in `web/src/components/editor/linkOptions.ts`, or drop
`workspaceAdminMiddleware` from `api/src/routes/workspaces.ts:1021`.

**Rollback.** `git revert` the branch. The only production code touched is the new
`linkOptions.ts` and the four `Link.configure` call sites that spread it; reverting restores
reliance on `@tiptap/extension-link`'s default `isAllowedUri`, which blocks the same five schemes
today.

---

## TRO-225 — [TEST-3] Retries hid a test that failed first-attempt in 100% of runs

**What was broken.** `playwright.config.ts:60` sets `retries: process.env.CI ? 2 : 1`. Across three
identical 869-test runs, counting **first attempts only**, 8 / 5 / 3 tests failed; after retries the
runner reported 1 / 0 / 1. Retries erased 7 / 5 / 2 failures
(`audit/test-quality/runs/e2e-flake-union.txt`). The worst case,
`my-week-stale-data.spec.ts › retro edits are visible on /my-week after navigating back`, **failed or
timed out on the first attempt in all three runs and was reported as passing all three times.**

**The recorded diagnosis was wrong.** That spec's header blamed Yjs persistence timing — "the retro
document IS created … but its Yjs content isn't persisted … even with a 10s wait … Needs
investigation on a separate branch." Two runs settle it (observed, `--workers=1 --retries=0`, this
worktree):

| invocation | result |
|---|---|
| `playwright test e2e/my-week-stale-data.spec.ts` | plan **passes**, retro **fails** — `getByText('Completed the API refactoring')` never appears |
| `playwright test e2e/my-week-stale-data.spec.ts -g "retro edits"` | retro **passes** (22.5 s) |

The retro test does not fail on its own merits. It fails **because the plan test ran first in the
same worker's database** — the "shared state inside a worker's database" root cause the finding
names, demonstrated rather than inferred.

**Mechanism** (read from the code, consistent with the above). When a weekly plan already exists for
the same person+week, `POST /api/weekly-retros` (`api/src/routes/weekly-plans.ts:641-656`) swaps
`WEEKLY_RETRO_TEMPLATE` for `buildRetroTemplateWithPlanItems(...)`: heading, then a `planReference`
node plus an empty `paragraph` per plan item, then an "Unplanned work" heading and a 3-item bullet
list. The old test clicked the editor's **centre**, so in that taller document the caret landed in a
top-level paragraph rather than inside a list item — and `extractPlanItems`
(`api/src/routes/dashboard.ts:279-309`) collects only `listItem`/`taskItem` text. The typed line
never reached the `/my-week` card. The failure screenshot confirms it: the retro card renders as a
**link** to a real document (so the document exists) whose body still reads "+ Create retro for this
week" (so `items` is empty).

**What changed** in `e2e/my-week-stale-data.spec.ts`:

1. **The cross-test dependency is gone.** `typeIntoFirstListItem()` places the caret in the first
   empty list item explicitly, so the typed text lands in the node type `/my-week` reads whichever
   template the API produced. Both tests use it.
2. **The fixed sleep is gone.** `await page.waitForTimeout(3000)` — a guess at how long persistence
   takes, and the second root-cause smell the finding lists — is replaced by
   `waitForMyWeekToContain()`, which polls `GET /api/dashboard/my-week` until the item is actually
   readable. This also *localises* the failure: a genuine persistence problem now fails at the poll
   with the API's own payload in the message, not 15 s later at a DOM assertion.
3. **Assertions are scoped to their card.** `myWeekSection(page, 'Weekly Retro')` prevents the retro
   assertion from being satisfied by the plan card.
4. The misleading "KNOWN FLAKY / needs investigation" header is replaced by the two-run evidence
   above.

**Decision on `retries`: left at `CI ? 2 : 1`, and here is why.** This branch fixed **1 of the 11**
tests on the flake list. Lowering retries — or setting `failOnFlakyTests: true`, which is the better
end state because it keeps the retry's trace artifact while refusing to score a retry-rescued test
as a pass — would immediately turn a misleadingly-green suite into a permanently-red one with ten
root causes still outstanding, and a permanently-red suite gets ignored exactly as fast as a
falsely-green one. It is a one-line change that costs nothing to defer and belongs with the *last*
flake fix, not the first. What has changed is that the choice is no longer invisible:
`playwright.config.ts` now carries the 8/5/3-vs-1/0/1 measurement, the pointer to
`e2e-flake-union.txt`, and the exact switch to flip. **No claim is made that the other ten flakes
are fixed.** They are:

`inline-comments.spec.ts › canceling a comment removes the highlight` (failed final in 2 of 3 runs —
the strongest remaining candidate), `mentions.spec.ts › should sync mentions between collaborators`,
`weekly-accountability.spec.ts › Allocation grid shows person with assigned issues…`,
`bulk-selection.spec.ts › shift+down then shift+up contracts selection`,
`my-week-stale-data.spec.ts › plan edits…` (flaky once; its fixed sleep is removed here too),
`performance.spec.ts › many images do not crash the editor`,
`programs.spec.ts › program cards show emoji or initial badges`,
`project-weeks.spec.ts › project link in Properties sidebar navigates back to project`,
`status-overview-heatmap.spec.ts › displays split cells for plan/retro status`,
`team-mode.spec.ts › clicking collapsed header expands the group`.

**Second finding, and the more serious one: the editor sometimes never receives a new document's
content.** Once the test asserted that the template had *arrived* — rather than typing into whatever
happened to be on screen — it began failing for an entirely different reason. **Observed**, three
repeat runs at `--workers=1 --retries=0`: run 1 clean, run 2 the *plan* document opened blank, run 3
the *retro* document opened blank. To a user that is a brand-new weekly plan opening as an empty
editor instead of the template.

**Derived** from code reading, not instrumented: `getOrCreateDoc`
(`api/src/collaboration/index.ts:220-226`) publishes the new `Y.Doc` into the shared `docs` map
*before* awaiting the database read and the `jsonToYjs` conversion at `:231-266`, and registers the
broadcasting `doc.on('update')` handler only afterwards. A second connection for the same document
arriving inside that window is handed the empty doc, is sent `writeSyncStep1` from it, and never
receives the conversion update — and `freshFromJsonDocs.delete(docName)` after the first client means
it does not get the cache-clear signal either. The shape of the fix is to store the load *promise* in
the map so concurrent callers await the same load. Needs its own ticket.

This also explains the **other** my-week entry on the flake list (`plan edits are visible on /my-week
…`, flaky in 1 of 3 audit runs), which the plan/retro template coupling does not — and it is very
probably what the original file header was reaching for when it blamed "Yjs persistence".

Until it is fixed, `typeIntoTemplateList` tolerates it with **one bounded reload** (`toPass`, the
construct `e2e/AGENTS.md` sanctions) and a failure message that names the finding and the file:line.
That is a workaround in the *setup* phase of a test whose subject is something else; it is not a
guard, because the assertion still has to pass, and it is not silent.

**Third finding, reported not fixed.** `extractPlanItems` exists in three copies with **divergent**
behaviour: `api/src/routes/dashboard.ts:279-309` collects only `listItem`/`taskItem`, while
`api/src/routes/weekly-plans.ts:63-95` and `api/src/services/ai-analysis.ts:69` also collect
top-level paragraphs longer than 10 characters. Consequence for a real user: an auto-populated retro
puts an empty `paragraph` under each `planReference` block *specifically so you write your update
there* — and `/my-week` then shows an **empty retro card**, because the dashboard reader ignores
paragraphs. That is a product bug, not a test bug; fixing it changes what `/my-week` displays, which
is out of scope for a test-integrity ticket. Needs its own ticket.

**Evidence.** Targeted specs only — the full suite was not run (600+ tests, per-worker containers,
not in the gate). Commands and results are in the PR body / final report; the decisive pair is the
two-run table above.

**How to run it.**

```bash
source .factory-env

# The configuration that reproduced the deterministic failure. 4 consecutive clean runs
# after the fix; before it, the retro test failed every time this way.
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0

# The two-run experiment that identified the cross-test dependency (run against `main`):
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0
pnpm exec playwright test e2e/my-week-stale-data.spec.ts --workers=1 --retries=0 -g "retro edits"
```

**Rollback.** `git revert` the branch. `playwright.config.ts` changes are comment-only, so reverting
restores the previous behaviour exactly.

---

## TRO-217 — [A11Y-3] `/my-week` failed colour contrast, the landing page of the app

**What was broken.** `/` redirects to `/my-week`, and it was the only key page Lighthouse failed on
accessibility: **95**, one failing audit, `color-contrast`. axe reported it **Serious** on 18 nodes
(24 in the audit baseline; the count tracks how many future standup rows the current week still
has, so it moves with the weekday).

The finding named two causes. There were **three**, and one of the two named was misattributed:

| Cause | Nodes | Resolved colour | Ratio |
|---|---|---|---|
| `opacity-40` on future standup rows (`MyWeekPage.tsx:339`) | 12 | `#3f3f3f` on `#0d0d0d` | **1.84:1** |
| `text-muted/50` on the 11px plan/retro ordinals | 4 | `#4c4c4c` on `#0d0d0d` | **2.26:1** |
| `text-accent` used as a *foreground* colour | 2 | `#005ea2` on `#0a1d2b` / `#0c1114` | **2.55:1** / 2.82:1 |

The dominant cause — two thirds of the nodes — was `opacity-40`, which the finding never mentioned.
And `bg-accent/20`, which the finding did blame, is not the defect: `accent` (`#005ea2`) is
**2.89:1 as text on the page background before any badge is involved**; the translucent fill only
takes it from 2.89 to 2.55. The fill was fine. Using a fill colour as text was not.

A **fourth** pair, in neither the finding nor either axe run: the "Unsubmitted" badge puts
`text-muted` on a `bg-border` fill at **4.38:1**. It renders only when a plan or retro has content,
is unsubmitted, and is not yet due — a state neither scan happened to hit. It is not a guess: axe
recorded that identical pair on the command palette's `esc` key
(`audit/a11y/axe/command_palette_open.json`).

**What changed.**

- `web/tailwind.config.js` — added `accent-text: #2491ff` (USWDS blue-40v, verified against
  `@uswds/uswds/.../tokens/color/_blue.scss`): **6.08:1** on `background`, 5.37:1 on a
  `bg-accent/20` badge, 5.94:1 on `bg-accent/5`. `accent` itself is **unchanged**, so every
  `bg-accent` fill in the app looks exactly as it did. blue-50v (`#0076d6`) was tried and rejected —
  4.22:1, still failing. Also corrected the `muted` comment, which claimed 5.1:1 where the
  arithmetic gives 5.63:1, and recorded the `bg-border` caveat next to it.
- `web/src/pages/MyWeekPage.tsx` — `opacity-40` removed from future rows in favour of a dimmer
  border; `text-muted/50` → `text-muted` on the two ordinals; `text-accent` → `text-accent-text` on
  the "Current" badge and today's day label; `text-muted` → `text-foreground` on the two
  "Unsubmitted" badges.

**Why the levels differ, since a global token change was the obvious move.**

- `opacity-40` was **page-level** because `MyWeekPage.tsx:339` was its *only* occurrence in
  `web/src`. Nothing else could be affected.
- `text-muted/50` was **page-level** because 10 of its 12 occurrences are on other pages
  (`PlanQualityBanner`, `DashboardVariantC` at `/dashboard`, `WorkspaceSettings`,
  `AdminWorkspaceDetail`, `Programs`, `MergeProgramDialog`, `HypothesisBlockComponent`). They fail
  too — 2.26:1 is a property of the token pair, not of this page — but they are outside A11Y-3 and
  are filed as a follow-up rather than swept in silently.
- `accent-text` was added at **token level** but applied only here. Adding a token cannot regress a
  page that currently passes; mutating `accent` could, because `accent` is a fill under white text
  in 80 places across 45 files. That mutation is a visual-identity decision, not a contrast fix.

**The tradeoff, stated because it is visible.** Future standup rows are no longer ghosted. They now
read as ordinary muted rows, distinguished by a dimmer border, the italic "Upcoming" label and the
absent status dot. This was not avoidable by tuning the opacity value: `text-muted` only clears
4.5:1 above roughly **86%** opacity, at which point nothing looks dimmed at all. Likewise the
ordinals lost their extra-quiet tier — on `#0d0d0d`, AA bottoms out around `#7a7a7a`, a 16-step
band below `muted`, so a perceptibly quieter *compliant* grey does not exist on this background.
Contrast won, as the ticket directed.

**Evidence.** Both ends measured on this branch, same conditions, not inherited from the audit:
`http://localhost:5683`, Chrome for Testing headless, 1440×900, `--preset=desktop`,
`--only-categories=accessibility`, authenticated as `dev@ship.local`, 523 seeded documents,
`ship_wt_tro_217`. Flags identical to `audit/a11y/run-lighthouse.sh` and `audit/a11y/axe-scan.mjs`.

| Measurement on `/my-week` | Before | After |
|---|---|---|
| Lighthouse accessibility | **95** | **100** |
| Lighthouse failing audits | 1 (`color-contrast`, 18 items) | **0** |
| axe `color-contrast` nodes | **18 Serious** | **0** |
| axe all severities | C0 **S1** M0 m0 | C0 S0 M0 m0 |

The audit baseline recorded 24 nodes and the ticket said 25; **18** is what the same page produced
here. The gap is the weekday (four remaining future days instead of six), not a different defect —
the per-node causes and ratios match the baseline artifact exactly.

**Regression test.** `web/src/pages/MyWeekPage.contrast.test.tsx` resolves the effective foreground
and background *colours* out of the rendered DOM and asserts the WCAG ratio, rather than asserting
a class string — so it survives a markup refactor and fails if a palette hex drifts back under
4.5:1. It renders four data states, because three of the page's pairs only exist under specific
data; a single-state check would have declared the page fixed while the 4.38:1 badge sat behind a
common plan state. `web/src/lib/contrast.test.ts` pins the resolver against numbers this project
did not compute — the exact `fgColor`/`bgColor`/`contrastRatio` values axe recorded in
`audit/a11y/axe/`.

Confirmed red first on the unfixed page: 6 failures, every one an `AssertionError` on the ratio
(21 of 39 pairs below 4.5:1 in the first state; named failures at 2.26:1, 1.85:1, 2.82:1, 4.38:1).
No import or locator errors.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 24 new tests; 13 known failures are TEST-1/TRO-223, unchanged
pnpm --filter @ship/web type-check
```

To re-measure against a browser, start the worktree's API and Vite, log in for a fresh
`session_id` (sessions expire in 15 minutes), then run Lighthouse and axe with the flags above.

**Roll back.** `git revert` the commits on `fix/a11y-3-contrast`, or by hand: restore `opacity-40`
on the future-row branch of `rowClass`, put back `text-muted/50` on the two ordinals,
`text-accent` on the "Current" badge and today's day label, `text-muted` on the two "Unsubmitted"
badges, and drop `accent-text` from the palette. The two new spec files fail if any of it comes
back, which is the point.

**Not established.** That a low-vision user can now read the page. Contrast ratios and axe output
are measured; the user-facing benefit is *derived* from them, and no human with low vision has
looked at this build. Also not established: that the repo's three Playwright a11y specs still pass
— they are not run by the factory gate and were not run here. One of them,
`e2e/accessibility-remediation.spec.ts:738` ("no color contrast violations on main pages"), runs
axe right after login, which lands on `/my-week`; it was almost certainly failing before this
change and should now pass, but that is a prediction, not a result.

**Found and not fixed** (filed as follow-ups, all measured):

1. `text-muted` on a `bg-border` fill is **4.38:1** and co-occurs in ~109 places in `web/src`.
   Raising `muted` from `#8a8a8a` to `#929292` (4.86:1 on `#262626`, 6.25:1 on `#0d0d0d`) fixes the
   whole class in one line and cannot lower contrast on any dark surface. Out of scope here because
   it is an app-wide tone change driven by pairs outside this page.
2. `text-accent` is **2.89:1** as small text on the page background wherever it renders — 80
   occurrences in 45 files. Only the two on `/my-week` were observed failing by axe; the rest is
   computed from the token, so treat the count as derived. `accent-text` now exists for them.
3. `bg-surface` is used in three files including `MyWeekPage.tsx`, but `surface` is **not a palette
   token**, so the class generates no CSS and those "cards" are painted with the page background.
   Harmless today; it silently changes the contrast maths for anything inside them if `surface` is
   ever defined.
4. `getContrastTextColor` in `web/src/lib/cn.ts` carries a second copy of the WCAG luminance
   formula now also in `web/src/lib/contrast.ts`. Collapsing them changes a shipped helper's
   behaviour on malformed input, so it was left alone.
5. `pnpm db:migrate` stopped after `010_oauth_state.sql` on a partially-migrated database and still
   reported success, leaving 10 of 42 migrations applied — the swallowed `already exists` catch at
   `api/src/db/migrate.ts:103-110`. This is **DB-1** reproducing; worked around by cloning a
   fully-migrated database rather than by touching the runner.

---

## TRO-215 — [A11Y-1] Navigation sidebars claimed `role="tree"` without a tree keyboard model

**What was broken.** `web/src/pages/App.tsx:637` declared
`<ul role="tree" aria-label="Workspace documents">`, which tells assistive technology "this is a
composite widget, enter interaction mode and navigate with arrow keys." Nothing implemented that
contract: no roving `tabIndex`, no `onKeyDown`, no `aria-level`/`aria-setsize`/`aria-posinset`
anywhere in `DocumentTreeItem.tsx` or `App.tsx`. The same pattern appeared in four more places.
Because `role="tree"` also overrides the `<ul>`'s list role, the two bare `<li>` children of that
list — the empty state and the "N more..." overflow link — became roleless orphans, producing axe
**Critical `aria-required-children`** plus **Serious `listitem`**.

**What changed.** Subtraction. `role="tree"`, `role="treeitem"` and `role="group"` are gone from
the document/context/project navigation sidebars, along with `aria-expanded`/`aria-selected` on
the `<li>` elements. The native `<ul>`/`<li>`/`<a>` structure is unchanged and needs no ARIA.

- `web/src/pages/App.tsx` — workspace + private document lists, the local `DocumentTreeItem`, and
  the projects list. `DocumentsTree` is now exported as a unit-test seam.
- `web/src/components/DocumentTreeItem.tsx` — the shared item used by the /docs tree view.
- `web/src/pages/Documents.tsx` — the container for the above; it had to move with the items,
  because a `role="tree"` whose children stop being treeitems is a *new* Critical.
- `web/src/components/ContextTreeNav.tsx`, `web/src/components/sidebars/ProjectContextSidebar.tsx`.

State that used to live on the `<li>` moved to where it is valid ARIA: `aria-expanded` is now on
the expand/collapse `<button>`s, and the active document was already marked with
`aria-current="page"` on its `<a>`.

**One behaviour change, from PR review.** Moving `aria-expanded` onto the buttons exposed that the
person row in `ProjectContextSidebar` was a `<button aria-expanded="false">` even for a person with
**no weeks** — controlling nothing, and with a provably no-op click (`togglePerson` writes
`expandedPeople`, read only by `isExpanded && hasWeeks`). That row is now a plain `<div>`: still
readable, no longer a phantom tab stop. People *with* weeks are unchanged — chevron, week count,
working `aria-expanded`. Reverting restores the focusable no-op button.

**Deliberately kept.** `aria-live="polite"` on the two document lists. It is the WCAG 4.1.3
mechanism for announcing create/delete and is asserted by
`e2e/accessibility-remediation.spec.ts` ("document tree updates are announced"). Whether it is
too verbose on expand/collapse is a screen-reader question, and removing it on a prediction is
the exact error A11Y-1 itself was — see the follow-up note below.

**Out of scope, deliberately.** `web/src/pages/OrgChartPage.tsx` keeps `role="tree"`: it is the
one real tree widget in the codebase (roving `tabIndex` at `:664`, `onKeyDown` at `:462`).

**Evidence.** axe-core 4.11 via `@axe-core/playwright`, Chromium 1223 headless, 1440×900, tags
`wcag2a,wcag2aa,wcag21a,wcag21aa,best-practice`, logged in as `dev@ship.local` against a locally
seeded database. Counts are Critical/Serious/Moderate/minor.

| page | before | after |
|---|---|---|
| `/docs` | **C1 S1** M0 m0 — `aria-required-children`, `listitem` | **C0 S0** M0 m0 |
| `/documents/:id` | **C2 S1** M1 m0 | **C1 S0** M1 m0 |
| `/issues` | C0 S0 M0 m1 | C0 S0 M0 m1 |

The Critical remaining on the document view is `aria-allowed-attr` on the editor `<div>` — that is
**A11Y-2**, a separate finding, untouched here.

**Reproduction precondition (worth knowing).** The violation is data-dependent: it only fires when
a sidebar section has **more than `SIDEBAR_ITEM_LIMIT` (10)** root documents, which renders the
bare `<li>` "N more..." overflow link, or **zero**, which renders the bare `<li>` empty state. A
freshly seeded database has 5 and shows **no** violation. The audit environment had more than 10.

**How to run it.**

```bash
pnpm --filter @ship/web test        # 5 new specs, 26 assertions, all green
pnpm type-check
```

**Rollback.** `git revert` the commits on `fix/a11y-1-sidebar-aria`, or by hand: restore the five
`role="tree"`/`role="treeitem"` sites listed above, and restore the person row in
`ProjectContextSidebar.tsx` to a single `<button>` for both the has-weeks and no-weeks cases. The
five new `*.test.tsx` files fail if either comes back, which is the point.

**Still owed — do not mark this fully verified.** Nobody has listened to it. A human found on
2026-07-28 that VoiceOver did not announce the document titles *at all* under the old markup;
this change makes the DOM use native list semantics and axe agrees, but **no screen-reader pass
has been run on the fixed build.** That verification, plus a judgement on the retained
`aria-live`, is outstanding.

---

## TRO-188 (ERR-1) + TRO-189 (ERR-2) — the editor stops lying about "Saved", and a revoked session stops writing

Both findings live in the collaboration path and ship as one change: TRO-189 makes the server hang
up on sockets whose session is gone, and TRO-188 makes the editor say so instead of showing
"Saved" over work that is not saved. Fixing one without the other would have produced a *silently*
disconnected editor — a worse version of ERR-1.

**What changed — TRO-189 / ERR-2 (security: logged-out user kept write access).**

The collaboration socket was authenticated exactly once, during the HTTP upgrade
(`api/src/collaboration/index.ts`, `server.on('upgrade')`), and never re-checked. Deleting or
expiring the session left the socket writing to `documents` indefinitely while REST correctly 401'd
(audit `probe7c`, `probe6.4`).

- Each connection now records the `sessionId` that authorized it (`DocConnection` / `EventConnection`).
- `revalidateLiveSessions()` re-checks every session backing a live socket on an interval
  (`DEFAULT_SESSION_REVALIDATION_INTERVAL_MS = 30_000`), in **one batched query** for all distinct
  sessions, applying the same two windows as the REST middleware (`SESSION_TIMEOUT_MS`,
  `ABSOLUTE_SESSION_TIMEOUT_MS`). Invalid → the socket is closed with code **4401**.
- It **fails open** on a database error: a transient outage must not disconnect every open editor.
- `closeSocketsForSession()` is called directly from `POST /api/auth/logout` and from the
  session-fixation rotation on login, so logout takes effect at once rather than up to 30s later.
- Connections are marked `revoked` *before* `ws.close()`, and inbound frames from a revoked
  connection are dropped — `close()` only starts the closing handshake, so without this an edit
  already in flight could still be persisted.

Behaviour change to be aware of: a session that has passed the 15-minute inactivity window now
loses its collaboration socket, where before only REST rejected it. Collaboration traffic
deliberately does **not** refresh `last_activity` — doing so would let an open tab keep a session
alive forever, which is a larger hole than the one being closed.

**What changed — TRO-188 / ERR-1 (data loss under a "Saved" label).**

`Editor.tsx` treated the WebSocket `status: connected` event as proof of persistence. It is not:
audit `probe2d-ws-unavailable.json` records **three** `connected` events and **zero** `sync` events,
with the indicator reading "Saved" for 60 s while `inDb=false`, ending in a document whose content
was `""`. `probe2-ws-drop` and `probe2e` show the same lie under the "Cached" label.

- The header indicator moved out of `Editor.tsx` into `web/src/components/editor/SyncStatusIndicator.tsx`
  with the derivation as a pure function (`deriveSyncIndicator`).
- "Saved" now requires `isSynced` — the y-websocket `sync` event, the only evidence the document
  reached the server. `status: connected` no longer sets it, and `sync(false)`/`disconnected`
  clears it.
- The unsynced state renders as **"Not saved"**, red, with a title that names the consequence
  ("changes … will be lost if you reload"). The reassuring "Cached" label is gone.
- A neutral "Connecting" state covers the first connection attempt only, so a normal page load does
  not flash a warning.
- Close code 4401 (TRO-189) stops the reconnect loop and drives the indicator to "Not saved",
  which is how a revoked session becomes visible to the user.

**How to run it.**

```bash
source .factory-env                       # api tests TRUNCATE 16 tables; use the worktree database
pnpm --filter @ship/api  exec vitest run src/collaboration/__tests__/session-revocation.test.ts
pnpm --filter @ship/web  exec vitest run src/components/editor/SyncStatusIndicator.test.tsx
scripts/factory/gate.sh
```

The api test drives the real collaboration server over a real WebSocket and asserts on the
`documents` table, not on a mock. It runs with a 200 ms revalidation interval via
`setupCollaboration(server, { sessionRevalidationIntervalMs })`.

**Rollback.** Revert the commits on `fix/err-1-err-2-collab-socket`. Independently:
for TRO-189 alone, delete the `revalidateLiveSessions`/`closeSocketsForSession` block in
`api/src/collaboration/index.ts` and its two call sites in `api/src/routes/auth.ts` — nothing else
depends on them, and `setupCollaboration`'s second argument is optional. For TRO-188 alone, pass a
permanently-true `isSynced` to `SyncStatusIndicator`, which restores the old "connected means
Saved" behaviour.

---

## TRO-172 — [API-1] Rate limiter no longer caps production at 100 req/min per IP

**What changed.** Two halves, server and client.

*Server* — `api/src/middleware/rate-limit.ts` (new) replaces the single `apiLimiter` that lived in
`api/src/app.ts`. `/api/` is now guarded by two chained limiters over the same 60 s window:

| Limiter | Key | Production limit | Purpose |
|---|---|---|---|
| `perSourceIpLimiter` | source IP | 6,000 / min (100 req/s) | anti-flood floor; makes the identity key unspoofable in aggregate |
| `perIdentityLimiter` | `session_id` cookie → `Bearer` token → source IP | 600 / min (10 req/s) | the budget users actually feel |

The old configuration was **100 / min keyed on IP**. Both numbers in it were wrong:

- *Unit.* The ceiling was sized as if one page view were one request. The audit's browser trace
  measured 63 `/api` requests across 8 flows (login 16, dashboard 12, document view 10, sprint
  board 10), so a user exhausted the window after ~6–10 navigations per minute.
- *Key.* With CloudFront → Elastic Beanstalk and `trust proxy 1`, every user behind one agency NAT
  egress resolved to the same IP, so a whole team shared one 100 req/min budget.

600 is justified against the measurement: the worst single-user burst is 16 XHRs × 20 navigations
per minute = 320 req/min, so 600 leaves ~1.9× headroom and still caps one session at 10 req/s.
6,000 accommodates ~187 simultaneously-active users behind one NAT egress at the measured average
of ~32 req/min per active user, while staying far below the 299–4,049 req/s this API was measured
to serve — a single-source flood is still capped. Test (10,000) and dev (1,000) budgets are
unchanged. Session ids and tokens are SHA-256 fingerprinted before use as bucket keys.

*Client* — `web/src/lib/queryClient.ts` now retries HTTP 429 for **queries and mutations** with a
2 s / 8 s / 20 s / 45 s backoff plus additive jitter. The schedule sums to ≥75 s so at least one
attempt lands after the server's 60 s window rolls over; React Query's default 1/2/4 s backoff
would exhaust itself inside the same window. Every other 4xx is still treated as permanent. If the
retries are exhausted the write is genuinely lost, so `MutationErrorToast` now raises a **sticky**
toast (`web/src/components/ui/Toast.tsx` gained `duration: 0` = no auto-dismiss) naming rate
limiting as the cause instead of a generic three-second message.

**Measured, NODE_ENV=production, concurrency 10, `GET /api/documents?type=wiki`, in-process listener:**

| Scenario | Before | After |
|---|---|---|
| 1,000 requests, no session cookie | 100 served / 900 throttled (90%) | 600 served / 400 throttled (40%) |
| 2,000 requests, 20 distinct sessions behind one IP | 100 served / 1,900 throttled (95%) | **2,000 served / 0 throttled** |

**How to run it.**

```bash
source .factory-env
pnpm --filter @ship/api test src/middleware/__tests__/rate-limit.test.ts
pnpm --filter @ship/web test src/lib/queryClient.test.ts src/components/MutationErrorToast.test.tsx
```

**Rollback.** Revert the commits, or by hand: delete `api/src/middleware/rate-limit.ts` and restore
the single `apiLimiter` (`windowMs: 60_000`, `max: isTestEnv ? 10000 : isDevEnv ? 1000 : 100`) plus
`app.use('/api/', apiLimiter)` in `api/src/app.ts`; restore the two inline `retry` predicates in
`web/src/lib/queryClient.ts` and drop `retryDelay`. The `Toast` `duration: 0` support and the
sticky-toast branch in `MutationErrorToast` are additive and safe to leave.

---

## Factory visibility — status command, published board, cost analysis (no ticket: tooling)

**What changed.** Three additions, all reading from sources of truth rather than a status file:

- `scripts/factory/lib/state.mjs` — reconstructs factory state from git worktrees, `.factory-env`,
  `.factory/gate-result.json`, `gh pr list`, `scorecard.jsonl`, and Claude Code session
  transcripts. No state file is written, because one that drifts reads as authoritative while
  being wrong.
- `scripts/factory/status.mjs` — one-screen terminal view. `--json` feeds the board.
- `scripts/factory/board.mjs` — renders a self-contained HTML control panel (cream ground,
  British racing green, severity carried by stripe + wash + text colour, all contrast-measured
  against WCAG AA rather than estimated). Single-theme by choice: both `data-theme` values are
  pinned to the cream tokens so the viewer's toggle cannot flip it.
- `scripts/factory/serve.mjs` — local server that rebuilds the board from live state on every
  request. This is the surface for *operating* the factory: free to refresh, no agent needed.
  The published Artifact can only be updated by an agent calling a tool, so it is for *sharing*
  a milestone, not for watching a run.
- `scripts/factory/cost-report.mjs` — the graded "AI cost analysis" deliverable
  (`projectbrief.md:63`), derived retroactively from transcripts that already record per-message
  token usage.

**Decision: not LangGraph.** The workers are Claude Code sub-agents with their own tool loops in
git worktrees, so a graph framework would orchestrate opaque subprocesses — the interesting
internals are exactly what it cannot see. The durable state (branch, gate result, PR, Linear
ticket) already exists; a checkpointer would duplicate it and then disagree with it.

**How to run it.**

```bash
node scripts/factory/status.mjs
node scripts/factory/board.mjs > audit/factory/board.html   # then republish to the same URL
node scripts/factory/cost-report.mjs > audit/factory/COST_ANALYSIS.md
```

**Rollback.** Remove `scripts/factory/{status,board,cost-report}.mjs`, `scripts/factory/lib/state.mjs`,
and `audit/factory/{board.html,COST_ANALYSIS.md}`. Nothing else depends on them.

---

## TRO-244 — CI pipeline with source-code inventory

**What changed.** Added `.github/workflows/ci.yml`: typecheck, build, and unit tests for both
packages on every PR and every push to `main`, plus a source-code inventory job that emits a
per-SHA manifest (files and lines per package, dependency tree, licenses) as a retained artifact.

Web unit tests run with `continue-on-error` because 13 are known-failing (TEST-1 / TRO-223). The
real gate is the step after them, which compares failure *identities* against
`audit/factory/quarantine.json` and fails only on **new** breakage.

`pnpm lint` is deliberately **not** wired in: finding TS-6 (TRO-211) established there is no
ESLint config anywhere, so the script exits 0 having checked nothing. Adding it would make CI
advertise a quality gate that does not exist.

**How to run it.** Automatic on PR and push to `main`; `workflow_dispatch` for a manual run.
Locally, the same checks are `scripts/factory/gate.sh`.

**Rollback.** Delete `.github/workflows/ci.yml`. Nothing else depends on it.

---

## Factory harness — ticket remediation infrastructure (no ticket: tooling)

> Exempt from this file's ticket-ID join-key rule. This is sprint tooling, not a fix for an audit
> finding, so it has no entry in `AUDIT_REPORT.md` and no Linear ticket to join to. Every *code*
> change below this line does carry its ID.


**What changed.** Added the machinery that drives audit findings to merged fixes:

- `scripts/factory/worktree.sh` — provisions an isolated worktree, a dedicated database, and
  per-ticket ports. Necessary because `api/src/test/setup.ts` TRUNCATEs 16 tables in the
  `beforeAll` of every api test file; agents sharing a database corrupt each other's runs.
- `scripts/factory/gate.sh` — the per-ticket eval: typecheck, build, unit tests vs the quarantine
  baseline, tests-not-weakened, regression-test-present, `CHANGES.md` entry, scope, CodeRabbit
  capture. Writes `.factory/gate-result.json`.
- `scripts/factory/lib/testdiff.mjs` — compares failure identities, not counts. Verified against a
  forged run where one test broke and one was fixed: totals unchanged at 13, gate correctly failed.
- `audit/factory/quarantine.json` — the 13 known-failing web tests, so agent regressions are
  distinguishable from pre-existing red.
- `.coderabbit.yaml` — review configuration with path instructions tied to Ship's conventions.
- `.claude/skills/ship-factory/` — orchestration, agent contract, eval tiers, escalation gates.

**How to run it.**

```bash
scripts/factory/worktree.sh TRO-178 fix/db-1-migration-runner
cd ../Ship-wt-tro_178 && source .factory-env
scripts/factory/gate.sh          # --fast for the inner loop
```

**Rollback.** Remove `scripts/factory/`, `audit/factory/`, `.coderabbit.yaml`, and
`.claude/skills/ship-factory/`. Clean up worktrees with `git worktree remove`, and drop the
per-ticket databases (`ship_wt_*`) from the `ship-audit-pg` container.

---

## TRO-243 — Secrets loading hard-failed on any host that is not AWS

**What changed.** `loadProductionSecrets()` fetched from AWS SSM with no error handling under
`NODE_ENV=production` and overwrote `DATABASE_URL`. Off AWS it threw and killed the process before
the database was ever contacted. It now falls back to environment secrets when they are present
and rethrows when they are not. AWS behaviour is unchanged.

**How to run it.** Set `DATABASE_URL`, `SESSION_SECRET`, and `CORS_ORIGIN` in the environment and
start with `NODE_ENV=production`.

**Rollback.** Revert the merge of `fix/ssm-fallback` (`5b72a79`).

---

## TRO-242 — Build the image from source and serve the SPA from the API

**What changed.** Multi-stage `Dockerfile` so the image builds from a clean checkout — the
previous one copied `shared/dist/` and `api/dist/`, both gitignored and untracked, so it only
worked in the build-locally-then-ship AWS flow. Express now serves `web/dist` after all `/api`
routes. Same-origin is required by `sameSite: 'strict'` session cookies and by the collaboration
WebSocket URL being derived from `window.location.host`.

**How to run it.** `docker build -t ship . && docker run -p 3000:3000 ship`, or deploy to Render,
which builds from the repository.

**Rollback.** Revert the merge of `feat/render-deploy` (`bace770`).

