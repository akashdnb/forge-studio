FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY public ./public
# Normalize the escaped template literal emitted in github-actions-backend.js before Node parses it.
RUN sed -i "s|const currentAttempt=.*;const r=|const currentAttempt=\" AND attempt=(SELECT attempts FROM forge_jobs WHERE id=job_id AND status='RUNNING')\";const r=|" src/execution/github-actions-backend.js \
    && node --check src/execution/github-actions-backend.js
EXPOSE 8080
CMD ["sh", "-c", "node scripts/ensure-tenant-schema.js && node src/server.js"]
