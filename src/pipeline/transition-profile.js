'use strict';

const TRANSITIONS = new Set(['CUT', 'FADE', 'FADE_IN']);

function transitionFilter(shotSpec, inputIndex, label, duration, width, height, fps = 30) {
  const intent = String(shotSpec?.transitionIntent || 'cut').trim().toUpperCase();
  const base = `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},trim=duration=${duration},setpts=PTS-STARTPTS`;
  if (!TRANSITIONS.has(intent) || intent === 'CUT') return `${base}[${label}]`;

  const fadeDuration = Math.min(0.5, Number(duration));
  return `${base},fade=t=in:st=0:d=${fadeDuration}:alpha=0[${label}]`;
}

module.exports = { TRANSITIONS, transitionFilter };
