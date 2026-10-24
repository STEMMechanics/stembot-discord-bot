FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV STATE_PATH=/app/data/state.json

EXPOSE 8080

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN apt-get update \
    && apt-get install --no-install-recommends -y fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data \
    && chown node:node /app/data

USER node

CMD ["node", "dist/index.js"]
