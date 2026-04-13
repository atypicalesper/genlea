FROM node:20-alpine AS base
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/svc-api/package.json services/svc-api/

RUN npm install --workspace=@genlea/shared --workspace=@genlea/svc-api

COPY packages/shared/src packages/shared/src
COPY services/svc-api/src services/svc-api/src
COPY services/svc-api/tsconfig.json services/svc-api/

EXPOSE 4000

CMD ["node", "--import=tsx/esm", "services/svc-api/src/server.ts"]
