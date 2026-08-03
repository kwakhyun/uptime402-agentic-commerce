FROM node:22.22.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps/control-plane/package.json apps/control-plane/tsconfig.json apps/control-plane/next.config.ts ./apps/control-plane/
COPY apps/control-plane/src ./apps/control-plane/src
COPY apps/control-plane/app ./apps/control-plane/app
COPY apps/control-plane/components ./apps/control-plane/components
COPY artifacts ./artifacts

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @uptime402/control-plane build

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /workspace/apps/control-plane
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
ENV UPTIME402_ARTIFACT_ROOT=/workspace/artifacts

COPY --from=build /workspace/apps/control-plane/.next/standalone /workspace
COPY --from=build /workspace/apps/control-plane/.next/static /workspace/apps/control-plane/.next/static
COPY --from=build /workspace/artifacts /workspace/artifacts

EXPOSE 8080
CMD ["server.js"]
