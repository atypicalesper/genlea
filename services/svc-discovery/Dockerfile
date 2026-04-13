FROM node:20-alpine AS base
WORKDIR /app

# Install Playwright system deps
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont \
    && addgroup -S pptruser && adduser -S -G pptruser pptruser

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json  packages/shared/package.json
COPY services/svc-discovery/package.json services/svc-discovery/package.json

RUN npm install --workspace=@genlea/shared --workspace=@genlea/svc-discovery --ignore-scripts

COPY packages/shared/src  packages/shared/src
COPY services/svc-discovery/src services/svc-discovery/src

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

USER pptruser
WORKDIR /app/services/svc-discovery
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
