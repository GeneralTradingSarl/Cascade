# Cascade runs as a long-lived process, not as serverless functions: it holds a SQLite file,
# drains a job queue on an interval, and receives Meta webhooks. Any host that gives it a
# container and a persistent disk works (Render, Railway, Fly, a plain VPS).
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
COPY workflows ./workflows

# The database lives on a mounted volume: a container restart must not lose the leads.
ENV DATABASE_PATH=/data/cascade.db
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
