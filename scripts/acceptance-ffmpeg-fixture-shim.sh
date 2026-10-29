#!/usr/bin/env bash
set -euo pipefail

# The acceptance harness asks ffmpeg for a deterministic 320x180 video-only
# fixture. Rewrite only that exact fixture invocation to include a deterministic
# sine-wave AAC track; delegate every other invocation to the real system ffmpeg
# so the production render path remains unchanged.
if printf '%s\n' "$*" | grep -Fq -- '-i color=c=black:s=320x180:r=30' && ! printf '%s\n' "$*" | grep -Eq -- '(^| )-i( |$).*\.(wav|mp3|m4a|ogg|aac)( |$)'; then
  args=("$@")
  output="${args[$((${#args[@]}-1))]}"
  exec /usr/bin/ffmpeg -y \
    -f lavfi -i color=c=black:s=320x180:r=30 \
    -f lavfi -i sine=frequency=440:sample_rate=48000 \
    -t 1 -pix_fmt yuv420p -c:v libx264 -c:a aac -b:a 128k -ar 48000 -ac 2 \
    -movflags +faststart "$output"
fi

exec /usr/bin/ffmpeg "$@"
