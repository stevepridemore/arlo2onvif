# Built from source so it works on both amd64 and aarch64 hosts.
FROM node:22-alpine

RUN apk add --no-cache git iproute2 jq bash

RUN git clone --depth 1 https://github.com/daniela-hase/onvif-server.git /app \
 && cd /app \
 && npm install --omit=dev \
 && rm -rf /app/.git

WORKDIR /app
COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
