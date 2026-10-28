const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { buildVisualRecipe, applyRecipeToTimeline } = require('../src/visual/visual-continuity');
const { compileTimeline } = require('../src/pipeline/timeline-manifest-compiler');
const { renderTimeline, sha256Json } = require('../src/pipeline/ffmpeg-renderer');

const versions = {
  'asset-a': { id: 'asset-a', kind: 'asset' },
  'asset-b': { id: 'asset-b', kind: 'asset' },
  'scene-plan:1': { id: 'scene-plan:1', kind: 'scene-plan' },
};

function makeRecipe() {
  return buildVisualRecipe({
    episodeId: 'ep-shot-duration',
    scenePlanVersionId: 'scene-plan:1',
    plan: {
      scenes: [{
        id: 'scene-1',
        shots: [
          { id: 'shot-a', shotType: 'B_ROLL', durationSeconds: 1.25, location: 'lab' },
          { id: 'shot-b', shotType: 'B_ROLL', durationSeconds: 2.75, location: 'lab' },
        ],
      }],
    },
    assets: [
      { id: 'asset-a', versionId: 'asset-a', role: 'PROCESS', description: 'lab process', location: 'lab' },
      { id: 'asset-b', versionId: 'asset-b', role: 'PROCESS', description: 'lab process', location: 'lab' },
    ],
  });
}

test('planner duration is carried into shotSpec and matches the compiled segment', () => {
  const recipe = makeRecipe();
  const timeline = applyRecipeToTimeline({
    durationSeconds: 4,
    tracks: [{
      type: 'VIDEO',
      segments: [
        { id: 'shot-a', start: 0, duration: 1.25, assetVersionId: 'asset-a' },
        { id: 'shot-b', start: 1.25, duration: 2.75, assetVersionId: 'asset-b' },
      ],
    }],
  }, recipe, new Map([
    ['asset-a', { id: 'asset-a', versionId: 'asset-a' }],
    ['asset-b', { id: 'asset-b', versionId: 'asset-b' }],
  ]));

  assert.equal(timeline.tracks[0].segments[0].shotSpec.durationSeconds, 1.25);
  assert.equal(timeline.tracks[0].segments[1].shotSpec.durationSeconds, 2.75);

  const compiled = compileTimeline({ episodeId: 'ep-shot-duration', timeline, versions });
  assert.deepEqual(compiled.tracks[0].segments.map((segment) => segment.duration), [1.25, 2.75]);
  assert.deepEqual(compiled.tracks[0].segments.map((segment) => segment.shotSpec.durationSeconds), [1.25, 2.75]);
  assert.equal(compiled.durationSeconds, 4);
});

test('compiler rejects a shotSpec duration that would otherwise be rendered at a different duration', () => {
  const timeline = {
    durationSeconds: 6,
    tracks: [{
      type: 'VIDEO',
      segments: [
        { id: 'shot-a', start: 0, duration: 3, assetVersionId: 'asset-a', shotSpec: { durationSeconds: 1.25 } },
        { id: 'shot-b', start: 3, duration: 3, assetVersionId: 'asset-b', shotSpec: { durationSeconds: 2.75 } },
      ],
    }],
  };

  assert.throws(
    () => compileTimeline({ episodeId: 'ep-shot-duration', timeline, versions }),
    (error) => error.code === 'SHOT_DURATION_MISMATCH'
      && error.details.segmentId === 'shot-a'
      && error.details.plannedDuration === 1.25
      && error.details.compiledDuration === 3,
  );
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

if (hasFfmpeg) {
  test('real media fixture proves the legacy renderer encoded 6s instead of planned 4s', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-shot-duration-'));
    const red = path.join(workDir, 'red.mp4');
    const blue = path.join(workDir, 'blue.mp4');
    const output = path.join(workDir, 'legacy-output.mp4');
    const timeline = {
      durationSeconds: 6,
      tracks: [{
        type: 'VIDEO',
        segments: [
          { id: 'shot-a', start: 0, duration: 3, sourcePath: 'red.mp4', shotSpec: { durationSeconds: 1.25 } },
          { id: 'shot-b', start: 3, duration: 3, sourcePath: 'blue.mp4', shotSpec: { durationSeconds: 2.75 } },
        ],
      }],
    };

    for (const [file, color] of [[red, 'red'], [blue, 'blue']]) {
      execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:r=30`,
        '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', file,
      ]);
    }

    await renderTimeline({
      input: {
        workDir,
        timelineVersionId: 'legacy-proof',
        timelineContentHash: sha256Json(timeline),
        inputVersionIds: ['asset-a', 'asset-b'],
        timeline,
      },
      workDir,
      outputPath: output,
    });

    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration:stream=nb_frames,time_base', '-of', 'json', output,
    ], { encoding: 'utf8' }));
    const stream = probe.streams.find((entry) => entry.time_base);
    assert.ok(stream);
    assert.equal(stream.nb_frames, '180');
    assert.equal(stream.time_base, '1/15360');
    assert.equal(Number(probe.format.duration), 6);
  });
} else {
  test('real media fixture requires ffmpeg', { skip: 'ffmpeg is unavailable in this CI environment' }, () => {});
}
