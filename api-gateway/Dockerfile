FROM node:22-alpine
WORKDIR /app
COPY api-gateway/package*.json ./api-gateway/
WORKDIR /app/api-gateway
RUN npm ci --omit=dev
WORKDIR /app
COPY shared ./shared
COPY api-gateway/src ./api-gateway/src
WORKDIR /app/api-gateway
EXPOSE 4000
CMD ["node", "src/index.js"]
