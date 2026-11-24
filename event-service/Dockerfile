FROM node:22-alpine

WORKDIR /app/event-service

COPY event-service/package*.json ./
RUN npm ci

COPY event-service/prisma ./prisma
COPY event-service/prisma.config.ts ./
COPY shared /app/shared
RUN npx prisma generate

COPY event-service/src ./src

EXPOSE 4003
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD node -e "fetch('http://127.0.0.1:4103/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]