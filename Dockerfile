FROM scratch
WORKDIR /app

COPY --chown=10001:10001 --chmod=755 target/x86_64-unknown-linux-musl/release/patrick-im-server /app/server

USER 10001:10001
EXPOSE 3456
ENV APP_PORT=3456
CMD ["/app/server"]
