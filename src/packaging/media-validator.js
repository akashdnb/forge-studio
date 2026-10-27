'use strict';

const { spawn } = require('node:child_process');

function runCommand(command, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { code: 'MEDIA_VALIDATION_TIMEOUT', retryable: true }));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { if (stdout.length < 20000) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 12000) stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, Object.assign(new Error(`Unable to start ${command}: ${error.message}`), { code: command === 'ffprobe' ? 'FFPROBE_UNAVAILABLE' : 'FFMPEG_UNAVAILABLE', retryable: true })));
    child.on('close', (code, signal) => {
      if (code === 0) return finish(resolve, { stdout, stderr });
      finish(reject, Object.assign(new Error(`${command} failed (${code || signal})${stderr ? `: ${stderr.trim()}` : ''}`), { code: 'MEDIA_VALIDATION_FAILED', retryable: false, stdout, stderr }));
    });
  });
}

function parseRate(value) {
  const [num, den] = String(value || '').split('/').map(Number);
  return den > 0 && Number.isFinite(num) ? num / den : Number(value);
}

async function validateMp4({ file, profile, ffprobePath = process.env.FORGE_FFPROBE_COMMAND || 'ffprobe', ffmpegPath = process.env.FORGE_FFMPEG_COMMAND || 'ffmpeg' }) {
  if (!file || !profile?.video || !profile?.audio) throw new TypeError('file and compiled delivery profile are required');
  let probe;
  try {
    const result = await runCommand(ffprobePath, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,sample_rate,channels:format=duration,size', '-of', 'json', file]);
    probe = JSON.parse(result.stdout);
  } catch (error) {
    if (error.code === 'FFPROBE_UNAVAILABLE') throw error;
    throw Object.assign(new Error(`Unable to inspect packaged MP4: ${error.message}`), { code: 'MEDIA_VALIDATION_FAILED', retryable: false });
  }
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video || !audio) throw Object.assign(new Error('Packaged MP4 must contain both video and audio streams'), { code: 'MEDIA_VALIDATION_FAILED', retryable: false });
  const fps = parseRate(video.avg_frame_rate);
  const duration = Number(probe.format?.duration);
  const checks = [
    ['video codec', video.codec_name === 'h264'],
    ['video width', Number(video.width) === Number(profile.video.width)],
    ['video height', Number(video.height) === Number(profile.video.height)],
    ['video fps', Number.isFinite(fps) && Math.abs(fps - Number(profile.video.fps)) < 0.01],
    ['pixel format', video.pix_fmt === profile.video.pixelFormat],
    ['audio codec', audio.codec_name === 'aac'],
    ['audio sample rate', Number(audio.sample_rate) === Number(profile.audio.sampleRate)],
    ['audio channels', Number(audio.channels) === Number(profile.audio.channels)],
    ['duration', Number.isFinite(duration) && duration > 0],
  ];
  const failed = checks.find(([, ok]) => !ok);
  if (failed) throw Object.assign(new Error(`Packaged MP4 failed ${failed[0]} validation`), { code: 'MEDIA_VALIDATION_FAILED', retryable: false, media: { video, audio, duration } });
  try {
    await runCommand(ffmpegPath, ['-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  } catch (error) {
    if (error.code === 'FFMPEG_UNAVAILABLE') throw error;
    throw Object.assign(new Error(`Packaged MP4 decode validation failed: ${error.message}`), { code: 'MEDIA_VALIDATION_FAILED', retryable: false });
  }
  return { durationSeconds: duration, video: { codec: video.codec_name, width: Number(video.width), height: Number(video.height), fps, pixelFormat: video.pix_fmt }, audio: { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: Number(audio.channels) } };
}

module.exports = { validateMp4, parseRate, runCommand };
