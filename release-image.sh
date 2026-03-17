#!/bin/bash

# 本地镜像发布脚本
# 用途：在开发机上使用 docker buildx 构建并推送跨平台镜像。

set -euo pipefail

IMAGE_REPO="${IMAGE_REPO:-}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
PLATFORMS="${PLATFORMS:-linux/amd64}"
PUSH_LATEST="${PUSH_LATEST:-true}"
BUILDER_NAME="${BUILDER_NAME:-patrick-im-builder}"

if [ -z "$IMAGE_REPO" ]; then
  echo "IMAGE_REPO 未设置，例如：your-acr-registry.example.com/your-namespace/patrick-im"
  exit 1
fi

echo "=========================================="
echo "开始发布 patrick-im 镜像"
echo "=========================================="

echo ""
echo ">>> 步骤 1: 准备 buildx builder"
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --use
else
  docker buildx use "$BUILDER_NAME"
fi
docker buildx inspect --bootstrap >/dev/null

echo ""
echo ">>> 步骤 2: 构建并推送镜像"
BUILD_ARGS=(
  --platform "$PLATFORMS"
  -t "${IMAGE_REPO}:${IMAGE_TAG}"
)
if [ "$PUSH_LATEST" = "true" ]; then
  BUILD_ARGS+=(-t "${IMAGE_REPO}:latest")
fi
docker buildx build "${BUILD_ARGS[@]}" --push .

echo ""
echo "=========================================="
echo "镜像发布完成"
echo "=========================================="
