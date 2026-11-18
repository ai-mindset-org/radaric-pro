# Radaric — self-host image
#
# DELIBERATE DECISION: NOT `output: "standalone"`.
# The worker runs uncompiled TS via `npx tsx` (scripts/start.sh) and the boot
# step runs the Prisma CLI (`scripts/migrate-safe.js`). Next's standalone
# tracing covers the server bundle only, so it would mean shipping a SECOND
# pruned node_modules for the worker — a container contract that has never run
# in production. The full-deps image below reproduces the EXACT Railway runtime
# (start.sh as PID 1, same signal path, same tsx worker); image size is the
# accepted cost. Revisit only if size becomes a real pain for self-hosters.

# Patch-pinned for a security fix (22.23.4). Bump deliberately; never float
# back to `node:22-slim`.
FROM node:22.23.4-slim

# Prisma's engines link against OpenSSL. python3, make and g++ build native
# modules that ship no prebuilt binary for linux-arm64 (bufferutil, pulled in by
# telegram → websocket): without them `npm ci` fails on Apple Silicon and ARM
# servers, while amd64 uses the prebuilds and never needs them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first (cache-friendly). `prisma/` must be present BEFORE `npm ci`
# because the project's postinstall runs `prisma generate`.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Application source.
COPY --chown=node:node . .

# Build. CI proves `next build` succeeds against an unreachable DATABASE_URL, so
# a dummy value is provided for the build step ONLY (an ARG is build-scoped and
# cannot leak into the runtime env; an ENV would become the operator's default).
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN DATABASE_URL="$DATABASE_URL" npm run build && chown -R node:node /app/.next

# Runtime contract (scripts/start.sh, docs/DEPLOYMENT.md):
#   - start.sh as PID 1 — never `sh -c "npm start"`: SIGTERM must reach BOTH the
#     worker and Next, or GramJS never destroy()s and Telegram invalidates the
#     session (AUTH_KEY_DUPLICATED — see docs/TELEGRAM_SETUP.md)
#   - web 3000, worker health 3001 (binds all interfaces; expose consciously)
#   - migrations run at boot via scripts/migrate-safe.js
EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["sh", "scripts/start.sh"]
