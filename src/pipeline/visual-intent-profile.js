'use strict';

const FRAME_ZOOM = Object.freeze({ WIDE: 1, MEDIUM_WIDE: 1.05, MEDIUM: 1.10, MEDIUM_CLOSE: 1.22, CLOSE: 1.38, EXTREME_CLOSE: 1.70, OVERHEAD: 1, POV: 1, TWO_SHOT: 1 });
const CAMERA_MOTIONS = new Set(['STATIC', 'PUSH_IN', 'PULL_OUT', 'PAN', 'TILT', 'DOLLY', 'TRACK', 'HANDHELD', 'ORBIT', 'PARALLAX']);
const TRANSITIONS = new Set(['CUT', 'FADE', 'FADE_IN']);

function getFramingZoom(shotSpec) { return FRAME_ZOOM[String(shotSpec?.framing || 'MEDIUM').toUpperCase()] || FRAME_ZOOM.MEDIUM; }

function visualIntentFilter(shotSpec, sourceIndex, outputLabel, duration, width = 1280, height = 720, fps = 30) {
  const spec = shotSpec || {};
  const zoom = getFramingZoom(spec);
  const motion = String(spec.cameraMotion || 'STATIC').toUpperCase();
  const transition = String(spec.transitionIntent || 'CUT').trim().toUpperCase();
  const safeDuration = Number(duration);
  const trim = `trim=duration=${safeDuration},setpts=PTS-STARTPTS`;
  let filter = `[${sourceIndex}:v]`;
  if (zoom === 1) filter += `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  else filter += `scale=${Math.ceil(width * zoom)}:${Math.ceil(height * zoom)}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`;
  filter += `,setsar=1,fps=${fps},${trim}`;
  if (CAMERA_MOTIONS.has(motion) && motion !== 'STATIC') {
    const zoomExpr = motion === 'PUSH_IN' || motion === 'DOLLY' || motion === 'ORBIT' || motion === 'PARALLAX'
      ? `1+0.08*min(1,on/(${fps}*${safeDuration}))`
      : motion === 'PULL_OUT' ? `1.08-0.08*min(1,on/(${fps}*${safeDuration}))`
      : ['PAN', 'TRACK'].includes(motion) ? '1.06'
      : motion === 'TILT' ? '1.06'
      : motion === 'HANDHELD' ? '1.04' : '1';
    const xExpr = ['PAN', 'TRACK'].includes(motion) ? `(iw-iw/zoom)*min(1,on/(${fps}*${safeDuration}))` : 'iw/2-(iw/zoom/2)';
    const yExpr = motion === 'TILT' ? `(ih-ih/zoom)*min(1,on/(${fps}*${safeDuration}))` : 'ih/2-(ih/zoom/2)';
    filter += `,zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${width}x${height}:fps=${fps},trim=duration=${safeDuration},setpts=PTS-STARTPTS`;
  }
  if (TRANSITIONS.has(transition) && transition !== 'CUT') filter += `,fade=t=in:st=0:d=${Math.min(0.5, safeDuration)}:alpha=0`;
  return `${filter}[${outputLabel}]`;
}

module.exports = { FRAME_ZOOM, CAMERA_MOTIONS, TRANSITIONS, getFramingZoom, visualIntentFilter };
