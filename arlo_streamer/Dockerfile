# Built from source rather than the upstream Docker image, because the
# upstream image is amd64-only and this keeps the version pinned.
FROM python:3.12-slim-bookworm

ARG ARLO_STREAMER_REF=v0.10.3
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${ARLO_STREAMER_REF}" \
      https://github.com/kaffetorsk/arlo-streamer.git /app \
 && pip install --no-cache-dir -r /app/requirements.txt

WORKDIR /app
COPY run.sh keepalive.py /app/
RUN chmod +x /app/run.sh

ENTRYPOINT ["/app/run.sh"]
