FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim

ARG BUILD_VERSION=development
ARG BUILD_BRANCH=unknown
ARG BUILD_COMMIT=unknown
ARG BUILD_PR=unknown
ARG BUILD_RELEASE=unreleased

ENV NODE_ENV=production
ENV STATE_PATH=/app/data/state.json
ENV STEMBOT_BUILD_VERSION=${BUILD_VERSION}
ENV STEMBOT_BUILD_BRANCH=${BUILD_BRANCH}
ENV STEMBOT_BUILD_COMMIT=${BUILD_COMMIT}
ENV STEMBOT_BUILD_PR=${BUILD_PR}
ENV STEMBOT_BUILD_RELEASE=${BUILD_RELEASE}

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
