#!/bin/bash

# Docker Compose 部署脚本
# 用途：
#   1. git-build 模式：服务器拉代码并本机构建
#   2. registry 模式：服务器直接拉取镜像仓库中的新镜像并重启

set -euo pipefail

# 配置变量
PROJECT_DIR="${PROJECT_DIR:-/home/patrick-im}"
DEPLOY_MODE="${DEPLOY_MODE:-registry}"

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    sudo docker "$@"
  fi
}

echo "=========================================="
echo "开始部署 patrick-im"
echo "=========================================="

# 1. 进入项目目录
echo ""
echo ">>> 步骤 1: 进入项目目录"
cd "$PROJECT_DIR"

# 2. 根据模式部署
if [ "$DEPLOY_MODE" = "git-build" ]; then
  echo ""
  echo ">>> 步骤 2: 更新代码"
  git pull --ff-only

  echo ""
  echo ">>> 步骤 3: 构建并重启服务"
  docker_cmd compose up -d --build --remove-orphans
else
  echo ""
  echo ">>> 步骤 2: 拉取镜像"
  docker_cmd compose pull app

  echo ""
  echo ">>> 步骤 3: 使用最新镜像重启服务"
  docker_cmd compose up -d --remove-orphans
fi

# 4. 清理旧镜像
echo ""
echo ">>> 步骤 4: 清理悬空镜像"
docker_cmd image prune -f

# 5. 显示运行状态
echo ""
echo ">>> 步骤 5: 当前运行状态"
docker_cmd compose ps

echo ""
echo "=========================================="
echo "部署完成！"
echo "=========================================="
