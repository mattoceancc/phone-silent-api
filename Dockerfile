FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json

RUN npm ci --omit=dev --workspace=@phone-silent/api --workspace=@phone-silent/shared --include-workspace-root

COPY packages/shared packages/shared
COPY packages/api packages/api

ENV NODE_ENV=production
ENV PORT=43124
EXPOSE 43124

CMD ["npm", "run", "start", "-w", "@phone-silent/api"]
