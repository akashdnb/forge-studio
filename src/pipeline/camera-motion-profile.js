'use strict';

const CAMERA_MOTIONS = new Set(['STATIC', 'PUSH_IN', 'PULL_OUT', 'PAN', 'TILT', 'DOLLY', 'TRACK', 'HANDHELD', 'ORBIT', 'PARALLAX']);

function escape(value) {
  return String(value).replace(/'/g, "\\'");
}

function motionFilter(shotSpec, inputIndex, label, duration, width, height) {
  const motion = String(shotSpec?.cameraMotion || 'STATIC').toUpperCase();
  if (!CAMERA_MOTIONS.has(motion) || motion === 'STATIC') {
    return `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,trim=duration=${escape(duration)},setpts=PTS-STARTPTS[${label}]`;
  }

  // Normalize first, then apply bounded motion over the fixed 1280x720 canvas.
  // zoompan emits exactly one frame per input frame (d=1), so timing remains tied
  // to the source FPS rather than changing the segment duration.
  const base = `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,trim=duration=${escape(duration)},setpts=PTS-STARTPTS`;
  const zoom = motion === 'PUSH_IN' || motion === 'DOLLY' || motion === 'ORBIT' || motion === 'PARALLAX'
    ? `1+0.08*min(1,on/(30*${escape(duration)}))`
    : motion === 'PULL_OUT'
      ? `1.08-0.08*min(1,on/(30*${escape(duration)}))`
      : ['PAN', 'TRACK'].includes(motion)
        ? '1.06'
        : motion === 'TILT'
          ? '1.06'
          : motion === 'HANDHELD'
            ? '1.04'
            : '1';
  const x = ['PAN', 'TRACK'].includes(motion)
    ? `(iw-iw/zoom)*min(1,on/(30*${escape(duration)}))`
    : `iw/2-(iw/zoom/2)`;
  const y = motion === 'TILT'
    ? `(ih-ih/zoom)*min(1,on/(30*${escape(duration)}))`
    : `ih/2-(ih/zoom/2)`;
  return `${base},zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=30,trim=duration=${escape(duration)},setpts=PTS-STARTPTS[${label}]`;
}

module.exports = { CAMERA_MOTIONS, motionFilter };
