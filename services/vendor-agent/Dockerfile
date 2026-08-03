FROM node:22.22.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY services/vendor-agent ./services/vendor-agent
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @uptime402/vendor-agent build

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/services/vendor-agent/dist ./services/vendor-agent/dist
# The entrypoint validates Firestore, Devnet, the facilitator-supported fee
# payer, the immutable catalog, and the mounted receipt key before listening.
CMD ["services/vendor-agent/dist/main.js"]
