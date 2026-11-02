# tandem-server: statisch gelinkte Binärdatei (musl) in einem leeren Image.
# Build-Kontext: das Verzeichnis server/  (docker build -f ../deploy/Dockerfile .)
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# Abhängigkeiten zwischenspeichern
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src target/release/deps/tandem_server*
COPY src ./src
RUN cargo build --release && strip target/release/tandem-server && mkdir -p /data

FROM scratch
COPY --from=build /src/target/release/tandem-server /tandem-server
# Benanntes Volume übernimmt Eigentümer aus dem Image → schreibbar für den unprivilegierten Nutzer
COPY --from=build --chown=10001:10001 /data /data
ENV TANDEM_DATA=/data TANDEM_LISTEN=0.0.0.0:8080 RUST_LOG=tandem_server=info
VOLUME /data
EXPOSE 8080
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["/tandem-server", "healthcheck"]
ENTRYPOINT ["/tandem-server"]
CMD ["serve"]
