FROM node:20-alpine AS base
WORKDIR /app

# ── Install workspace deps ─────────────────────────────────────────────────────
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/svc-scoring/package.json services/svc-scoring/

RUN npm install --workspace=@genlea/shared --workspace=@genlea/svc-scoring

# ── Copy source ────────────────────────────────────────────────────────────────
COPY packages/shared/src packages/shared/src
COPY services/svc-scoring/src services/svc-scoring/src
COPY services/svc-scoring/tsconfig.json services/svc-scoring/

CMD ["node", "--import=tsx/esm", "services/svc-scoring/src/index.ts"]
