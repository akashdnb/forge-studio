FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY migrations ./migrations
COPY public ./public
EXPOSE 8080
CMD ["node", "src/server.js"]
