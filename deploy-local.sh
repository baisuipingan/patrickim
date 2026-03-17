#!/bin/bash

# 本地一键发版脚本：
# 1. 读取 .env 和 .env.local
# 2. 登录阿里云镜像仓库
# 3. 本地 buildx 构建并推送 linux/amd64 镜像
# 4. 把部署文件和 .env 同步到服务器
# 5. 服务器拉取新镜像并重启

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

load_env_file() {
  local file="$1"
  if [ -f "$file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

load_env_file "$ROOT_DIR/.env"
load_env_file "$ROOT_DIR/.env.local"

IMAGE_REPO="${IMAGE_REPO:-${APP_IMAGE%:*}}"
ACR_REGISTRY="${ACR_REGISTRY:-${IMAGE_REPO%%/*}}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
REMOTE_IMAGE_TAG="${REMOTE_IMAGE_TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64}"
PUSH_LATEST="${PUSH_LATEST:-true}"
BUILDER_NAME="${BUILDER_NAME:-patrick-im-builder}"
SSH_STRICT_HOST_KEY_CHECKING="${SSH_STRICT_HOST_KEY_CHECKING:-no}"

missing=()
for name in \
  APP_IMAGE \
  DEPLOY_SERVER_HOST \
  DEPLOY_SERVER_PORT \
  DEPLOY_SERVER_USER \
  DEPLOY_SERVER_PASSWORD \
  DEPLOY_PROJECT_DIR \
  ACR_REGISTRY \
  ACR_USERNAME \
  ACR_PASSWORD \
  IMAGE_REPO; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "以下配置未填写，请先补齐 $ROOT_DIR/.env 或 $ROOT_DIR/.env.local："
  printf '  - %s\n' "${missing[@]}"
  exit 1
fi

SSH_OPTS=(-p "$DEPLOY_SERVER_PORT" -o "StrictHostKeyChecking=$SSH_STRICT_HOST_KEY_CHECKING")
SCP_OPTS=(-P "$DEPLOY_SERVER_PORT" -o "StrictHostKeyChecking=$SSH_STRICT_HOST_KEY_CHECKING")
TARGET="${DEPLOY_SERVER_USER}@${DEPLOY_SERVER_HOST}"

SSH_CMD=(ssh "${SSH_OPTS[@]}")
SCP_CMD=(scp "${SCP_OPTS[@]}")
if command -v sshpass >/dev/null 2>&1; then
  SSH_CMD=(sshpass -p "$DEPLOY_SERVER_PASSWORD" ssh "${SSH_OPTS[@]}")
  SCP_CMD=(sshpass -p "$DEPLOY_SERVER_PASSWORD" scp "${SCP_OPTS[@]}")
fi

echo "=========================================="
echo "开始一键发版 patrick-im"
echo "=========================================="
echo "镜像仓库: $IMAGE_REPO"
echo "服务器: $TARGET:$DEPLOY_PROJECT_DIR"
echo "构建平台: $PLATFORMS"

echo ""
echo ">>> 步骤 1: 登录本地阿里云镜像仓库"
printf '%s' "$ACR_PASSWORD" | docker login --username="$ACR_USERNAME" --password-stdin "$ACR_REGISTRY"

echo ""
echo ">>> 步骤 2: 准备 buildx builder"
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --use
else
  docker buildx use "$BUILDER_NAME"
fi
docker buildx inspect --bootstrap >/dev/null

echo ""
echo ">>> 步骤 3: 构建并推送镜像"
BUILD_ARGS=(
  --platform "$PLATFORMS"
  -t "${IMAGE_REPO}:${IMAGE_TAG}"
)
if [ "$PUSH_LATEST" = "true" ]; then
  BUILD_ARGS+=(-t "${IMAGE_REPO}:latest")
fi
docker buildx build "${BUILD_ARGS[@]}" --push .

echo ""
echo ">>> 步骤 4: 准备服务器目录"
"${SSH_CMD[@]}" "$TARGET" "mkdir -p '$DEPLOY_PROJECT_DIR/deploy/nginx'"

echo ""
echo ">>> 步骤 5: 同步部署文件到服务器"
"${SCP_CMD[@]}" "$ROOT_DIR/.env" "$TARGET:$DEPLOY_PROJECT_DIR/.env"
"${SCP_CMD[@]}" "$ROOT_DIR/docker-compose.yml" "$TARGET:$DEPLOY_PROJECT_DIR/docker-compose.yml"
"${SCP_CMD[@]}" "$ROOT_DIR/deploy.sh" "$TARGET:$DEPLOY_PROJECT_DIR/deploy.sh"
"${SCP_CMD[@]}" "$ROOT_DIR/deploy/nginx/nginx.conf" "$TARGET:$DEPLOY_PROJECT_DIR/deploy/nginx/nginx.conf"

echo ""
echo ">>> 步骤 6: 服务器登录镜像仓库并更新容器"
"${SSH_CMD[@]}" "$TARGET" /bin/bash <<EOF
set -euo pipefail
cd $(printf '%q' "$DEPLOY_PROJECT_DIR")
printf '%s' $(printf '%q' "$ACR_PASSWORD") | docker login --username $(printf '%q' "$ACR_USERNAME") --password-stdin $(printf '%q' "$ACR_REGISTRY")
chmod +x deploy.sh
DEPLOY_MODE=registry ./deploy.sh
EOF

echo ""
echo "=========================================="
echo "发版完成"
echo "=========================================="
