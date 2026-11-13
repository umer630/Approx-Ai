# Approx AI backend + web app (single container). One runtime dependency: @libsql/client (database driver).
FROM node:22.13-bookworm-slim
ENV NODE_ENV=production APPROX_ENV=production APPROX_DATA_DIR=/data PORT=8080
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force
COPY backend ./backend
COPY web ./web
RUN useradd --system --uid 10001 approx && mkdir -p /data && chown approx /data
USER approx
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "backend/src/server.js"]
