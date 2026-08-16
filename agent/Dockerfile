# FleetGraph agent service — self-contained image, built from a clean
# checkout (Render clones the repo and builds; no local `pnpm build` needed
# first). Mirrors the root Dockerfile's structure (build stage compiles
# everything from source, runtime stage carries only the compiled dist +
# prod deps) — see that file's own header for why (both dist/ and
# node_modules/ are gitignored, so a platform that clones-and-builds needs
# the source, not pre-built artifacts).
#
# Docker Hub is blocked in government environments; both stages use the ECR
# public mirror, same as the root Dockerfile.
#
# Build context is the REPO ROOT (not agent/), because pnpm workspace
# resolution needs to see pnpm-workspace.yaml and the lockfile. See
# terraform/render/agent_service.tf's `docker_context`/`dockerfile_path`.

# ─────────────────────────── build ───────────────────────────
FROM public.ecr.aws/docker/library/node:20-slim AS build

WORKDIR /app

RUN npm install -g pnpm@10.27.0

# Manifests first, so dependency layers cache independently of source
# changes. pnpm-workspace.yaml lists api/web/shared/agent/sdk — every listed
# package needs its package.json present for `pnpm install` to resolve the
# workspace, even though only agent/ (plus its @ship/sdk workspace
# dependency) is actually built in this image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY agent/package.json ./agent/
COPY sdk/package.json ./sdk/

# --ignore-scripts: the root postinstall runs `git config`, which fails
# because .git is excluded by .dockerignore.
RUN pnpm install --frozen-lockfile --ignore-scripts

# agent/src/shipClient.ts imports @ship/sdk (PF-702/PF-703) — build it first
# so its dist/ + type declarations exist for @ship/agent's own build.
COPY sdk/ ./sdk/
RUN pnpm --filter @ship/sdk build

COPY agent/ ./agent/
RUN pnpm --filter @ship/agent build

# ────────────────────────── runtime ──────────────────────────
FROM public.ecr.aws/docker/library/node:20-slim AS runtime

WORKDIR /app

RUN npm install -g pnpm@10.27.0

# Runtime needs agent/ + its @ship/sdk workspace dependency — same trimming
# the root Dockerfile's runtime stage does for its own dependents (api +
# shared, not web).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agent/package.json ./agent/
COPY sdk/package.json ./sdk/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @ship/agent... && pnpm store prune

COPY --from=build /app/sdk/dist ./sdk/dist
COPY --from=build /app/agent/dist ./agent/dist

ENV NODE_ENV=production

# PORT is intentionally NOT set — the host injects it (Render does) and
# agent/src/config.ts reads process.env.PORT, falling back to 3100.
EXPOSE 3100

WORKDIR /app/agent
CMD ["node", "dist/index.js"]
