# GitHappens OAuth broker. No npm dependencies: Node 22 runs the TypeScript sources directly
# (type stripping, Node >= 22.18). Build from this directory:
#   docker build -t githappens-oauth-broker services/oauth-broker
FROM node:22-alpine

ENV NODE_ENV=production \
    GH_BROKER_HOST=0.0.0.0 \
    GH_BROKER_PORT=8080

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src

# The image's built-in unprivileged user; the app files stay root-owned and read-only to it.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GH_BROKER_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
