const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCaptionBundle, renderSrt, renderWebVtt, validateTranscript } = require('../../src/captions/caption-worker');

const transcriptArtifact = { id: 'tr-1', version_id: 'transcript-v1', content_hash: 'a'.repeat(64) };
const transcript = {
  schemaVersion: 'forge-transcript-v1', language: 'en-US', segments: [
    { id: 's1', start: 0, end: 1.5, text: 'Hello,  world!  🌋', confidence: 0.91 },
    { id: 's2', start: 1.5, end: 3.2, text: 'This is a deterministic caption test.', confidence: 0.88 },
  ],
};

test('normalizes Unicode/whitespace and produces deterministic VTT/SRT', () => {
  const first = buildCaptionBundle({ transcript, transcriptArtifact });
  const second = buildCaptionBundle({ transcript, transcriptArtifact });
  assert.deepEqual(first.checksums, second.checksums);
  assert.match(first.vtt, /^WEBVTT\nLanguage: en-US\n/);
  assert.match(first.srt, /1\n00:00:00,000 --> 00:00:01,500\nHello, world! 🌋/u);
  assert.equal(first.metadata.cueCount, 2);
});

test('rejects missing, unordered, overlapping, and out-of-range transcript segments', () => {
  assert.throws(() => validateTranscript({ language: 'en-US', segments: [] }));
  assert.throws(() => validateTranscript({ language: 'en-US', segments: [{ start: 1, end: 2, text: 'a' }, { start: 1.5, end: 3, text: 'b' }] }));
  assert.throws(() => validateTranscript({ language: 'en-US', segments: [{ start: 0, end: 1, text: 'a' }] }, { durationSeconds: 0.5 }));
  assert.throws(() => validateTranscript({ language: 'en-US', segments: [{ start: 0, end: 0.05, text: 'a' }] }));
});

test('renders standards-compatible timestamp separators', () => {
  const cues = [{ index: 1, startMs: 0, endMs: 1250, text: 'Hi' }];
  assert.match(renderWebVtt(cues, 'en'), /00:00:00\.000 --> 00:00:01\.250/);
  assert.match(renderSrt(cues), /00:00:00,000 --> 00:00:01,250/);
});
