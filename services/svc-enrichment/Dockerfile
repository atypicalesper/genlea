FROM node:20-alpine AS base
WORKDIR /app

RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont \
    && addgroup -S pptruser && adduser -S -G pptruser pptruser

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json  packages/shared/package.json
COPY services/svc-enrichment/package.json services/svc-enrichment/package.json

RUN npm install --workspace=@genlea/shared --workspace=@genlea/svc-enrichment --ignore-scripts

COPY packages/shared/src  packages/shared/src
COPY services/svc-enrichment/src services/svc-enrichment/src

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

USER pptruser
WORKDIR /app/services/svc-enrichment
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
