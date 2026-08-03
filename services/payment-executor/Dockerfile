FROM node:22.22.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY services/payment-executor ./services/payment-executor
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @uptime402/payment-executor build

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/services/payment-executor/dist ./services/payment-executor/dist
# The entrypoint fails closed before listening if any production dependency,
# Devnet identity, IAM principal, or mounted existing signer is unavailable.
CMD ["services/payment-executor/dist/main.js"]
