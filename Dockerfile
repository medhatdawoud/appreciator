# Builds the API server image, with the widget bundle baked in so the server
# can serve it at /widget.js. Migrations run at container start.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/widget/package.json packages/widget/
COPY packages/svg-gen/package.json packages/svg-gen/
RUN npm ci

COPY tsconfig.base.json ./
COPY site site
COPY packages/shared packages/shared
COPY packages/widget packages/widget
COPY packages/server packages/server
RUN npm run build -w @appreciator/shared \
 && npm run build -w @appreciator/widget \
 && npm run build -w @appreciator/server


FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/widget/package.json packages/widget/
COPY packages/svg-gen/package.json packages/svg-gen/
RUN npm ci --omit=dev -w @appreciator/server && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/widget/dist packages/widget/dist
COPY --from=build /app/packages/server/dist packages/server/dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["sh", "-c", "node packages/server/dist/db/migrate.js && exec node packages/server/dist/server.js"]
