# Dependency preparation only; run native probes later with --network none.
FROM node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0 AS node
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
