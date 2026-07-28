# Ship — self-contained production image.
#
# The previous single-stage image copied pre-built shared/dist and api/dist from
# the build context, which only works when someone has run `pnpm build` locally
# first (the AWS flow: scripts/deploy.sh builds, then docker build packages).
# Both directories are gitignored, so that image cannot build from a clean
# checkout — a platform that clones the repo and builds (Render, CI) fails at
# COPY with "no source files were found".
#
# This builds everything inside the image instead, so `docker build .` works
# from a fresh clone with no prior local state. It also builds the frontend,
# which the old image omitted entirely, so the API can serve the SPA from the
# same origin — required because the session cookie is sameSite=strict and the
# collaboration WebSocket URL is derived from window.location.host.
#
# Docker Hub is blocked in government environments; both stages use the ECR
# public mirror.

# ─────────────────────────── build ───────────────────────────
FROM public.ecr.aws/docker/library/node:20-slim AS build

WORKDIR /app

# Relaxed TLS for government VPN environments (must precede any npm command)
RUN npm config set strict-ssl false
RUN npm install -g pnpm@9.15.4 && pnpm config set strict-ssl false

# Manifests first, so dependency layers cache independently of source changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/
COPY web/package.json ./web/

# Full dependency tree — dev dependencies are needed to compile.
# --ignore-scripts: the root postinstall runs `git config`, which fails because
# .git is excluded by .dockerignore, and husky has nothing to install against.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY shared/ ./shared/
COPY api/ ./api/
COPY web/ ./web/

# Builds shared → api → web in workspace dependency order.
# VITE_API_URL is deliberately empty: the SPA is served from the same origin as
# the API, so it uses relative URLs.
ENV VITE_APP_ENV=production
ENV VITE_API_URL=
RUN pnpm build

# ────────────────────────── runtime ──────────────────────────
FROM public.ecr.aws/docker/library/node:20-slim AS runtime

WORKDIR /app

RUN npm config set strict-ssl false
RUN npm install -g pnpm@9.15.4 && pnpm config set strict-ssl false

# Runtime needs api + shared only; web ships as static files, not as a package.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune

COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/api/dist   ./api/dist
COPY --from=build /app/web/dist   ./web/dist

ENV NODE_ENV=production

# PORT is intentionally NOT set — the host injects it (Render does) and
# api/src/index.ts reads process.env.PORT, falling back to 3000.
EXPOSE 3000

WORKDIR /app/api
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
