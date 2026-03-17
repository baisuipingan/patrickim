# Build frontend first
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Build backend
FROM rust:1.93-bookworm AS backend-builder
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
RUN cargo build --release

# Final runtime image
FROM debian:bookworm-slim
WORKDIR /app
RUN useradd --system --uid 10001 --home-dir /app appuser
COPY --from=backend-builder /app/target/release/patrick-im-server ./server
USER appuser
EXPOSE 3456
ENV APP_PORT=3456
CMD ["./server"]
