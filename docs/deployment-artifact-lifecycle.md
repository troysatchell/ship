# Deployment artifact lifecycle — build once, promote (TRO-246)

Assignment rule 5. This document is the third leg of a three-step progression:

1. **TRO-242** made the Docker image buildable from a clean checkout at all — the root `Dockerfile`
   builds `shared` → `api` → `web` inside the image itself, instead of requiring someone to have run
   `pnpm build` on a laptop first. See the header comment in `Dockerfile` for why.
2. **TRO-246 (this ticket)** makes CI build that image exactly once per commit and push it to a
   registry by immutable SHA tag — see [`CI builds and pushes the image`](#ci-builds-and-pushes-the-image)
   below.
3. **The Render switch** (this ticket prepares it; a human executes it — see
   [Render switch runbook](#render-switch-runbook-human-executed--held)) changes the `ship` service
   from *building the Dockerfile itself on Render's infrastructure* to *pulling and running the exact
   image CI already built from source that had already passed `verify` (typecheck, full build, unit
   tests vs. the quarantine baseline)*. Until that switch happens, Render performs its own,
   independent build of the same Dockerfile — same source, but a **different build**, run in a
   different environment, at a different time, than the one CI verified. That gap is what "build
   once" closes.

   **What this does NOT establish:** `verify` checks the source; it does not boot the built
   container and probe it. Neither this ticket nor `verify` adds a container-level smoke test (e.g.,
   `docker run` the image and hit `/health`) — the image is *built from tested source*, not itself
   *tested as a running container*, in CI. That gap is real and pre-existing (it applies equally to
   Render's own current build-and-run today); closing it would be a `docker run` + health-check step
   added to `build-image`, which is a reasonable follow-up but is not part of this ticket's scope.

## CI builds and pushes the image

Job: `build-image` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

- **What's built.** The same root `Dockerfile` `docker build .` builds today — multi-stage,
  self-contained, no dependency on pre-built `dist/` directories in the build context (those are
  gitignored; see the `Dockerfile` header comment for why the old single-stage image couldn't build
  from a fresh clone at all).
- **When.** The job `needs: verify`, so it only runs once typecheck, the full build, and the unit
  tests vs. the quarantine baseline have already passed — a doomed commit or PR never gets a docker
  build, and `main` never pushes an image for code that failed its own gate.
  - **On a push to `main`:** builds AND pushes.
  - **On every pull request:** builds, but does **not** push. This is deliberate: it proves the
    Dockerfile stays buildable from whatever the PR changed (a broken `COPY` path, a moved
    `package.json`, a new workspace package not wired into the multi-stage copy list — anything that
    would otherwise only be discovered when `main`'s image build fails, after merge) without ever
    authenticating to the registry or minting a tag for code that hasn't landed. A fork PR's
    `GITHUB_TOKEN` has no package-write scope anyway (GitHub enforces that regardless of the
    workflow's declared `permissions:`), so skipping the push step there isn't just tidiness.
- **Where it's stored.** GitHub Container Registry, `ghcr.io/troysatchell/ship`, pushed with the
  repo's built-in `GITHUB_TOKEN` (job-scoped `permissions: packages: write` — the workflow-level
  default is `contents: read` only, and job-level `permissions:` *replaces* that default for the job
  rather than adding to it, so `contents: read` is restated alongside `packages: write`).
- **Tags.**
  - `ghcr.io/troysatchell/ship:<full-40-char-git-sha>` — immutable. This is the artifact identity
    the rollback procedure below promotes and demotes by.
  - `ghcr.io/troysatchell/ship:main` — a moving tag, always the newest image pushed from `main`.
    Convenient for "deploy whatever's current"; **do not** use it as a rollback target — by
    definition it moves out from under you on the very next push.
- **Registry visibility.** Not yet set — a brand-new GHCR package defaults to **private**
  regardless of the parent repo's visibility, and GitHub's own docs describe changing that as a
  one-way trip ("once you make a package public, you cannot make it private again"). Deciding
  public-vs-private-with-credential is part of the Render switch runbook below, not this CI change,
  because it has no effect until something outside GitHub Actions needs to pull the image.

## Local build proof (observed, this ticket)

Run from a clean worktree at commit `3bc90ed` (this branch's base):

```bash
docker build -t ship:tro-246-local -f Dockerfile .
```

**Observed:** built successfully in ~28s (warm layer cache from a prior local build of the same
Dockerfile; a fully cold pull of the `node:20-slim` base adds time but not correctness). Image size
**482 MB** (`docker images` — `docker inspect --format='{{.Size}}'` reports a smaller ~97 MB because
that field counts only layers not already shared with another local image; 482 MB is the number that
matters for "how big is the thing I'm shipping").

**Derived / a real divergence from what CI will produce, not just a caveat:** this build ran on
Apple Silicon and produced a `linux/arm64` image (`docker inspect --format='{{.Architecture}}'` →
`arm64`). GitHub's `ubuntu-latest` runners are `amd64`, so CI's `build-image` job will produce
`linux/amd64` — which is also what Render's infrastructure runs. **Do not** treat a locally-built
image as interchangeable with CI's output beyond "the Dockerfile builds" — never push a
locally-built image to GHCR as a stand-in for a CI-built one; only CI's `linux/amd64` build is the
artifact this whole pipeline is designed to promote.

**`.dockerignore` divergence:** none expected. The build context is the same for a local `docker
build .` and CI's `actions/checkout` + `docker build` — both apply the same `.dockerignore`, and
none of the files it excludes (`.git`, `node_modules`, `*.md`, `docs/`, `.env*`, test files) are
things the `Dockerfile`'s `COPY` instructions ever reference. The one structural difference —
CI checks out at `fetch-depth: 0` for `verify`/`inventory` but the default shallow depth for
`build-image` — doesn't matter here either: `.dockerignore` excludes `.git` from the build context
regardless of clone depth, so the image never sees git history either way.

## Workflow-file verification (this ticket)

**Verified, observed this session:** `.github/workflows/ci.yml` parses cleanly as YAML —
`js-yaml@4.1.1` (already a transitive dependency in this repo's `node_modules/.pnpm`, loaded
directly by absolute path) parsed the file and confirmed the `build-image` job's `needs`,
`permissions`, and step list came out exactly as authored.

**Not run, and cannot be from here — mark as derived until the first real push:** whether the job
actually executes correctly under GitHub Actions (action resolution, secrets, GHCR auth, the
`if:`/`env.SHOULD_PUSH` conditional actually gating push the way it does when parsed locally).
`actionlint` is not installed in this environment, so only structural YAML validity was checked, not
Actions-specific semantics (e.g., valid `needs:` graph, valid expression syntax beyond what a YAML
parser can see). **The first push to `main` after this PR merges is the live test.**

## Render switch runbook (human-executed — HELD)

This is an outward-facing, live-service change (escalation gate 2 — irreversible/outward-facing
action) and was **not executed** as part of this ticket. No Render API call was made; the live
service, its credentials, and the repo-root `.env` were not touched. What follows is the exact
procedure for whoever runs it.

### Precondition

At least one push to `main` must have gone through **after** this PR's `build-image` job exists on
`main`, so a real `ghcr.io/troysatchell/ship:<sha>` tag exists to point at. Confirm one exists before
starting — either via the GitHub UI at `https://github.com/troysatchell/ship/pkgs/container/ship`,
or via `docker pull ghcr.io/troysatchell/ship:<sha>` from any machine with registry access once
visibility (below) is decided.

### Step 1 — make the image pullable by Render

Pick one:

- **Public.** Simpler — needs no credential wiring on Render's side at all — but it is a one-way,
  human decision, not an automatic consequence of the repo already being public: the repo's
  visibility decision was about source code, this is about a built artifact, and they are not
  necessarily the same call. Before doing this, have a human actually look at what the image
  contains (this Dockerfile does not bake in `DATABASE_URL`/`SESSION_SECRET` — those are runtime env
  vars set on the container, not build args — but confirm that's still true before publishing, not
  after) and confirm publishing it is acceptable. If so:
  GitHub UI → repo → **Packages** (right sidebar) → `ship` package → **Package settings** (gear) →
  **Danger Zone** → **Change visibility** → **Public** → confirm by typing the package name.
  **This is one-way** — GitHub's own docs state a public package cannot be made private again.
- **Private, with a registry credential on Render.** Render dashboard → **Workspace Settings** →
  **Container Registry Credentials** → **Add credential**: registry `ghcr.io`, username a GitHub
  username, password a GitHub PAT (classic or fine-grained) scoped `read:packages` against
  `troysatchell/ship`. Reference this credential when configuring the image in Step 3.

### Step 2 — pick the image reference

Use the **immutable SHA tag**, not `:main`: `ghcr.io/troysatchell/ship:<full-40-char-sha>`. Using
`:main` for anything you might later want to roll back from defeats the point — it will have moved
by the time you need it.

### Step 3 — point the Render service at the image

Read the current service first (safe, read-only, no side effects):

```bash
curl https://api.render.com/v1/services/srv-d9kf2t942hec73aofrt0 \
  -H "Authorization: Bearer $RENDER_API_KEY"
```

**Preferred — in place, keeps the same service id and the same public URL
(`https://ship-rr6m.onrender.com`, the graded submission URL):**

```bash
curl -X PATCH https://api.render.com/v1/services/srv-d9kf2t942hec73aofrt0 \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  -d '{"image": {"imagePath": "ghcr.io/troysatchell/ship:<sha>"}}'
```

**Not independently verified this session — derived, treat as a template, not a confirmed
contract.** Render's public API reference for the Update Service endpoint (`PATCH
/v1/services/:serviceId`) documents `image` as a body field, but does not publish its full
sub-schema on the pages this ticket could reach, and the raw OpenAPI spec was not reachable from
this environment either. Before running the command above: `GET` the service (as above) and, if
in doubt, create one throwaway "Existing Image" service via the dashboard flow below, `GET` it back,
and read the exact shape Render assigned to its `image` field — mirror *that* shape in the PATCH
against the real `ship` service rather than guessing blind. If a private registry credential from
Step 1 is in play, the same object almost certainly needs a credential reference too (the dashboard
calls this field "Registry Credentials," populated from Workspace Settings) — same caveat applies.

**Fallback — fully documented, supported flow, at the cost of a new service id/URL:** Render
dashboard → **New** → **Web Service** → **Existing Image** → paste
`ghcr.io/troysatchell/ship:<sha>` → attach the same `ship-db` Postgres instance (`oregon`, must
match region) → set the same three env vars (`DATABASE_URL` via *Add from Database* → Internal,
`SESSION_SECRET`, `CORS_ORIGIN`) → deploy → verify `/health` on the **new** service's own
`onrender.com` URL before touching the old one. Render's own docs don't address converting an
existing git-build service to an image-deploy service in place — only creating a new one this way —
so this path is the one with no unverified-schema risk. Its cost: a new service gets its own
subdomain; reusing `ship-rr6m.onrender.com` would mean deleting the old service, which is exactly the
kind of irreversible step to confirm with a human before doing, given it's the graded submission
URL. Do not delete the existing service as part of this runbook without that confirmation.

### Step 4 — verify

- `curl <active-service-url>/health` returns healthy, where `<active-service-url>` is
  `https://ship-rr6m.onrender.com` if you took the in-place PATCH path, or the **new** service's own
  auto-assigned `onrender.com` URL if you took the fallback dashboard path — do not curl the old
  `ship-rr6m` URL expecting it to reflect a fallback-path deploy, since in that case it's still the
  untouched, unconverted original service.
- In the Render dashboard, confirm the service's **Deploys** tab now shows an image-based deploy
  (an image digest/tag, not "building commit `<sha>`..."). This is the actual proof the switch took
  — a git-build service keeps showing build logs even when nothing else about it changed, so "it's
  still serving traffic" alone doesn't prove the switch happened.
- While here: the service's health check path is **unset** (per `memory-bank/techContext.md`; should
  be `/health`, `api/src/app.ts:165`). Pre-existing gap, not introduced by this ticket, but worth
  setting during the same maintenance window.

### Step 5 — rollback to a previous SHA

Repeat Step 3 with the previous known-good `<sha>` in place of the current one (found via `git log`
on `main`, or the previous entry in this file's own change history / `CHANGES.md`). Because CI
already built and pushed that commit's image, rollback is **"point at an old tag,"** not "rebuild an
old commit and hope it comes out the same" — that substitution is the entire point of separating
build from release from run.

**Not verified this session:** whether a GHCR cleanup/retention policy exists for this package.
GHCR's default is to keep container versions indefinitely (no automatic expiry) — but no cleanup
policy has been deliberately configured either way for this package yet, so confirm one hasn't been
added before assuming an old SHA tag is still there. If a target tag has been pruned, the fallback is
checking out that historical commit on a branch and re-running the `build-image` job's build step
(or an equivalent local `docker build .` on `linux/amd64`, e.g. `docker buildx build --platform
linux/amd64 ...` — see the local-build-vs-CI architecture divergence noted above) rather than trusting
an emulated or wrong-architecture rebuild.

## What this ticket did NOT do

- Did not call the Render API, read/rotate any credential, or touch the live `ship` service.
- Did not change GHCR package visibility (Step 1 above is unexecuted).
- Did not modify `scripts/deploy.sh` / `scripts/deploy-frontend.sh` (the AWS path) — out of scope for
  this ticket; AWS prod is separately known to be unreachable (`memory-bank/techContext.md`,
  2026-07-28) and unaffected by any of the above.
