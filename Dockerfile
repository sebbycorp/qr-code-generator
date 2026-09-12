FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app

ENV SHORT_STORAGE=sqlite
ENV SHORT_DB_PATH=/app/data/shortener.sqlite

EXPOSE 4242

USER node

CMD ["node", "server.js"]
