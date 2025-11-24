# Build frontend first
FROM node:18 AS frontend-builder
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend .
# Wails normally generates this, but we don't need it anymore.
# However, if you have imports relying on it, you might need to mock or remove them.
# We already cleaned up App.jsx.
RUN npm run build

# Build backend
FROM golang:1.21 AS backend-builder
WORKDIR /app
# Set GOPROXY for faster and reliable downloads in China
ENV GOPROXY=https://goproxy.cn,direct
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Copy the built frontend assets into the expected location for embedding
COPY --from=frontend-builder /app/dist ./frontend/dist
# Build a static binary
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

# Final lightweight image
FROM alpine:latest
WORKDIR /root/
COPY --from=backend-builder /app/server .
EXPOSE 3456
CMD ["./server"]
