#!/usr/bin/env bash
set -euo pipefail

FFMPEG_BIN="${FORGE_FFMPEG_COMMAND:-ffmpeg}"

# Rewrite only the deterministic video-only acceptance fixture so it also has
# the AAC audio stream required by the final artifact gate. Delegate every
# other ffmpeg invocation unchanged to the configured production binary.
if printf '%s\n' "$*" | grep -Fq -- '-i color=c=black:s=320x180:r=30' && ! printf '%s\n' "$*" | grep -Eq -- '(^| )-i( |$).*\.(wav|mp3|m4a|ogg|aac)( |$)'; then
  args=("$@")
  output="${args[$((${#args[@]}-1))]}"
  exec "$FFMPEG_BIN" -y \
    -f lavfi -i color=c=black:s=320x180:r=30 \
    -f lavfi -i sine=frequency=440:sample_rate=48000 \
    -t 1 -pix_fmt yuv420p -c:v libx264 -c:a aac -b:a 128k -ar 48000 -ac 2 \
    -movflags +faststart "$output"
fi

exec "$FFMPEG_BIN" "$@"
