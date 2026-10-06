FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --no-frozen-lockfile && pnpm db:generate && pnpm --filter @shadowcheck/web build
EXPOSE 3000 4000
