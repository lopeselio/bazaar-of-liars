# One container serves the web game (apps/web/dist) and the API on $PORT.
# Secrets come from the host's env (NEARAI_API_KEY, SERVER_PRIVATE_KEY), never the image.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/merchant/package.json packages/merchant/
COPY packages/verify/package.json packages/verify/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
COPY examples examples
RUN pnpm build
ENV NODE_ENV=production \
    PORT=8080 \
    NEAR_NETWORK=testnet \
    BAZAAR_CONTRACT_ID=v2.bazaar-liars.testnet \
    SERVER_ACCOUNT_ID=bazaar-server.testnet \
    NEARAI_BASE_URL=https://cloud-api.near.ai/v1 \
    NEARAI_MODEL=Qwen/Qwen3.6-35B-A3B-FP8
EXPOSE 8080
USER node
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/server.ts"]
