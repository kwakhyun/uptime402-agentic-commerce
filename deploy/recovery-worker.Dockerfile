FROM node:22.22.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps/control-plane ./apps/control-plane
COPY scripts/reissue-paid-incident.ts ./scripts/
RUN pnpm install --frozen-lockfile
COPY deploy/recovery-worker.tsup.ts ./deploy/
RUN pnpm exec tsup --config deploy/recovery-worker.tsup.ts

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /workspace
ENV NODE_ENV=production
ENV NODE_OPTIONS=--conditions=react-server
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/dist ./dist
CMD ["dist/recovery-worker/reissue-paid-incident.js"]
