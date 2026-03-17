FROM scratch
WORKDIR /app

# 运行时根目录由仓库内预置，避免 scratch 镜像里没有可写目录。
COPY --chown=10001:10001 deploy/runtime-rootfs/ /
COPY --chown=10001:10001 --chmod=755 target/x86_64-unknown-linux-musl/release/patrick-im-server /app/server

USER 10001:10001
EXPOSE 3456
ENV APP_PORT=3456
CMD ["/app/server"]
