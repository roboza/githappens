# GitHappens Cloud (spec 14). Node 22 runs the TypeScript sources directly (type stripping,
# Node >= 22.18); the only npm runtime dependency is `pg`.
#
# Build from the REPOSITORY ROOT (the image also needs packages/cloud-api):
#   docker build -f services/cloud/Dockerfile -t githappens-cloud .
# Dockerfile.dockerignore (next to this file) limits the context to the few files needed.

FROM node:22-alpine AS deps
WORKDIR /deps
# package.json uses pnpm's workspace protocol, which npm cannot read: install pg on its own.
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund --no-package-lock pg@8.23.1

FROM node:22-alpine
ENV NODE_ENV=production \
    GH_CLOUD_HOST=0.0.0.0 \
    GH_CLOUD_PORT=8787 \
    GH_CLOUD_DATA_DIR=/data \
    GH_CLOUD_BLOB_DIR=/data/blobs

WORKDIR /app
COPY --chown=root:root packages/cloud-api/package.json packages/cloud-api/package.json
COPY --chown=root:root packages/cloud-api/src packages/cloud-api/src
COPY --chown=root:root services/cloud/package.json services/cloud/package.json
COPY --chown=root:root services/cloud/src services/cloud/src
COPY --chown=root:root services/cloud/migrations services/cloud/migrations
COPY --chown=root:root services/cloud/openapi.json services/cloud/openapi.json
COPY --from=deps --chown=root:root /deps/node_modules services/cloud/node_modules
# Link the contract package like pnpm does. Node resolves the symlink to /app/packages/…, outside
# node_modules, so its TypeScript sources can be type-stripped.
RUN mkdir -p services/cloud/node_modules/@githappens \
 && ln -s ../../../../packages/cloud-api services/cloud/node_modules/@githappens/cloud-api \
 && mkdir -p /data/blobs && chown -R node:node /data

# The image's built-in unprivileged user; app files stay root-owned and read-only to it.
USER node
WORKDIR /app/services/cloud
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GH_CLOUD_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
