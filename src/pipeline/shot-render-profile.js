'use strict';

const FRAME_ZOOM = Object.freeze({
  WIDE: 1,
  MEDIUM_WIDE: 1.05,
  MEDIUM: 1.10,
  MEDIUM_CLOSE: 1.22,
  CLOSE: 1.38,
  EXTREME_CLOSE: 1.70,
  OVERHEAD: 1,
  POV: 1,
  TWO_SHOT: 1,
});

function getFramingZoom(shotSpec) {
  const framing = String(shotSpec?.framing || 'MEDIUM').toUpperCase();
  return FRAME_ZOOM[framing] || FRAME_ZOOM.MEDIUM;
}

function framingFilter(shotSpec, sourceLabel, outputLabel, duration, width = 1280, height = 720) {
  const zoom = getFramingZoom(shotSpec);
  const trim = `trim=duration=${duration},setpts=PTS-STARTPTS`;
  if (zoom === 1) {
    return `[${sourceLabel}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,${trim}[${outputLabel}]`;
  }
  const scaledWidth = Math.ceil(width * zoom);
  const scaledHeight = Math.ceil(height * zoom);
  return `[${sourceLabel}:v]scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2,setsar=1,fps=30,${trim}[${outputLabel}]`;
}

module.exports = { FRAME_ZOOM, getFramingZoom, framingFilter };
