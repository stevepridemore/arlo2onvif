# Built from source so it works on both amd64 and aarch64 hosts.
FROM node:22-alpine

# daniela-hase/onvif-server, pinned. Bump deliberately; patch-upstream.js
# checks that the code it edits still looks the same.
ARG ONVIF_SERVER_COMMIT=7aa2c541b67b1a2760887a1706d7a5e45e5ae1a4

RUN apk add --no-cache git iproute2 jq bash

RUN git clone https://github.com/daniela-hase/onvif-server.git /app \
 && cd /app \
 && git checkout --quiet "${ONVIF_SERVER_COMMIT}" \
 && npm install --omit=dev \
 && npm install --omit=dev mqtt@5 \
 && rm -rf /app/.git

WORKDIR /app
COPY patch-upstream.js events-server.js events-bridge.js /app/
RUN node patch-upstream.js /app/src/onvif-server.js /app/main.js \
 && node --check /app/src/onvif-server.js \
 && node --check /app/main.js

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
