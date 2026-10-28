'use strict';

const FRAME_ZOOM = Object.freeze({ WIDE: 1, MEDIUM_WIDE: 1.05, MEDIUM: 1.10, MEDIUM_CLOSE: 1.22, CLOSE: 1.38, EXTREME_CLOSE: 1.70, OVERHEAD: 1, POV: 1, TWO_SHOT: 1 });
const CAMERA_MOTIONS = new Set(['STATIC', 'PUSH_IN', 'PULL_OUT', 'PAN', 'TILT', 'DOLLY', 'TRACK', 'HANDHELD', 'ORBIT', 'PARALLAX']);
const TRANSITIONS = new Set(['CUT', 'FADE', 'FADE_IN']);

function framingZoom(shotSpec) { const framing = String(shotSpec?.framing || 'MEDIUM').toUpperCase(); return FRAME_ZOOM[framing] || FRAME_ZOOM.MEDIUM; }

function motionParams(shotSpec, duration) {
  const motion = String(shotSpec?.cameraMotion || 'STATIC').toUpperCase();
  if (!CAMERA_MOTIONS.has(motion) || motion === 'STATIC') return null;
  const progress = `min(1,on/(30*${Number(duration)}))`;
  const zoom = ['PUSH_IN', 'DOLLY', 'ORBIT', 'PARALLAX'].includes(motion) ? `1+0.08*${progress}` : motion === 'PULL_OUT' ? `1.08-0.08*${progress}` : ['PAN', 'TRACK'].includes(motion) ? '1.06' : motion === 'TILT' ? '1.06' : motion === 'HANDHELD' ? '1.04' : '1';
  const x = ['PAN', 'TRACK'].includes(motion) ? `(iw-iw/zoom)*${progress}` : 'iw/2-(iw/zoom/2)';
  const y = motion === 'TILT' ? `(ih-ih/zoom)*${progress}` : 'ih/2-(ih/zoom/2)';
  return { zoom, x, y };
}

function renderFilter(shotSpec, inputIndex, label, duration, width = 1280, height = 720, fps = 30) {
  const spec = shotSpec || {};
  const zoom = framingZoom(spec);
  const motion = motionParams(spec, duration);
  const baseScale = zoom === 1
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
    : `scale=${Math.ceil(width * zoom)}:${Math.ceil(height * zoom)}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`;
  const base = `[${inputIndex}:v]${baseScale},setsar=1,fps=${fps},trim=duration=${Number(duration)},setpts=PTS-STARTPTS`;
  let filter = base;
  if (motion) filter += `,zoompan=z='${motion.zoom}':x='${motion.x}':y='${motion.y}':d=1:s=${width}x${height}:fps=${fps},trim=duration=${Number(duration)},setpts=PTS-STARTPTS`;
  const transition = String(spec.transitionIntent || 'CUT').trim().toUpperCase();
  if (TRANSITIONS.has(transition) && transition !== 'CUT') filter += `,fade=t=in:st=0:d=${Math.min(0.5, Number(duration))}:alpha=0`;
  return `${filter}[${label}]`;
}

module.exports = { FRAME_ZOOM, CAMERA_MOTIONS, TRANSITIONS, framingZoom, motionParams, renderFilter };
