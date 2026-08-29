FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./server.mjs
USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
