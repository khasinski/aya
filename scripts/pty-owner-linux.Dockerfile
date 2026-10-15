# Dependency preparation only. Run the component/package probes with --network none.
FROM node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 \
    libcups2 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*
