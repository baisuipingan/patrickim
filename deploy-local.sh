#!/bin/bash

# 本地一键发版脚本：
# 1. 读取 .env 和 .env.local
# 2. 本机构建前端静态资源
# 3. 本机用 cargo-zigbuild 交叉编译 Linux 可执行文件
# 4. 打包运行镜像并推送到阿里云镜像仓库
# 5. 把部署文件和 .env 同步到服务器
# 6. 服务器拉取新镜像并重启

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
PLATFORMS="${PLATFORMS:-linux/amd64}"
PUSH_LATEST="${PUSH_LATEST:-true}"
RUST_TARGET="${RUST_TARGET:-}"
CURRENT_CONTEXT="$(docker context show)"
SSH_STRICT_HOST_KEY_CHECKING="${SSH_STRICT_HOST_KEY_CHECKING:-no}"
SERVER_BINARY=""

infer_rust_target() {
  case "$PLATFORMS" in
    linux/amd64)
      echo "x86_64-unknown-linux-musl"
      ;;
    linux/arm64)
      echo "aarch64-unknown-linux-musl"
      ;;
    *)
      echo ""
      ;;
  esac
}

if [ -z "$RUST_TARGET" ]; then
  RUST_TARGET="$(infer_rust_target)"
fi

if [ -z "$RUST_TARGET" ]; then
  echo "无法根据 PLATFORMS=$PLATFORMS 推断 Rust 目标，请在 .env.local 中显式设置 RUST_TARGET。"
  exit 1
fi

if [[ "$PLATFORMS" == *,* ]]; then
  echo "当前脚本只支持单平台发布，请把 PLATFORMS 设置成单个平台，例如 linux/amd64。"
  exit 1
fi

SERVER_BINARY="target/$RUST_TARGET/release/patrick-im-server"

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

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "缺少命令：$name"
    exit 1
  fi
}

require_command docker
require_command cargo
require_command zig
require_command npm

if ! cargo zigbuild --help >/dev/null 2>&1; then
  echo "缺少 cargo-zigbuild，请先执行：cargo install cargo-zigbuild"
  exit 1
fi

echo "=========================================="
echo "开始一键发版 patrick-im"
echo "=========================================="
echo "镜像仓库: $IMAGE_REPO"
echo "服务器: $TARGET:$DEPLOY_PROJECT_DIR"
echo "构建平台: $PLATFORMS"
echo "Rust 目标: $RUST_TARGET"

echo ""
echo ">>> 步骤 1: 构建前端产物"
if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  (
    cd "$ROOT_DIR/frontend"
    npm ci
  )
fi
(
  cd "$ROOT_DIR/frontend"
  npm run build
)

echo ""
echo ">>> 步骤 2: 交叉编译 Linux 可执行文件"
cargo zigbuild --release --target "$RUST_TARGET"
if [ ! -f "$SERVER_BINARY" ]; then
  echo "未找到编译产物：$SERVER_BINARY"
  exit 1
fi

echo ""
echo ">>> 步骤 3: 登录本地阿里云镜像仓库"
printf '%s' "$ACR_PASSWORD" | docker login --username="$ACR_USERNAME" --password-stdin "$ACR_REGISTRY"

echo ""
echo ">>> 步骤 4: 构建运行镜像"
docker buildx use "$CURRENT_CONTEXT" >/dev/null 2>&1 || true
BUILD_ARGS=(--platform "$PLATFORMS" --load -t "${IMAGE_REPO}:${IMAGE_TAG}")
if [ "$PUSH_LATEST" = "true" ]; then
  BUILD_ARGS+=(-t "${IMAGE_REPO}:latest")
fi
docker buildx build "${BUILD_ARGS[@]}" .

echo ""
echo ">>> 步骤 5: 推送镜像"
docker push "${IMAGE_REPO}:${IMAGE_TAG}"
if [ "$PUSH_LATEST" = "true" ]; then
  docker push "${IMAGE_REPO}:latest"
fi

echo ""
echo ">>> 步骤 6: 准备服务器目录"
"${SSH_CMD[@]}" "$TARGET" "mkdir -p '$DEPLOY_PROJECT_DIR'"

echo ""
echo ">>> 步骤 7: 同步部署文件到服务器"
"${SCP_CMD[@]}" "$ROOT_DIR/.env" "$TARGET:$DEPLOY_PROJECT_DIR/.env"
"${SCP_CMD[@]}" "$ROOT_DIR/docker-compose.yml" "$TARGET:$DEPLOY_PROJECT_DIR/docker-compose.yml"
"${SCP_CMD[@]}" "$ROOT_DIR/deploy.sh" "$TARGET:$DEPLOY_PROJECT_DIR/deploy.sh"

echo ""
echo ">>> 步骤 8: 服务器登录镜像仓库并更新容器"
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
