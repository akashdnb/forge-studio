const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

function inside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved.startsWith(resolvedRoot + path.sep);
}

/**
 * Piper TTS adapter. Piper executable/model/voice files are supplied by deployment.
 * It never downloads models and never shells out through a command string.
 */
class PiperTtsProvider {
  constructor({ executable = process.env.PIPER_EXECUTABLE || 'piper', modelPath = process.env.PIPER_MODEL_PATH, outputRoot, timeoutMs = 120000 }) {
    if (!modelPath) throw new TypeError('PIPER_MODEL_PATH is required');
    if (!outputRoot) throw new TypeError('outputRoot is required');
    this.name = 'piper';
    this.model = path.basename(modelPath);
    this.executable = executable;
    this.modelPath = path.resolve(modelPath);
    this.outputRoot = path.resolve(outputRoot);
    this.timeoutMs = timeoutMs;
  }

  async execute(request, context) {
    if (typeof request.text !== 'string' || !request.text.trim()) throw new TypeError('TTS request.text is required');
    const outputPath = path.resolve(request.outputPath || path.join(this.outputRoot, `${context.runId}.wav`));
    if (!inside(this.outputRoot, outputPath)) throw new Error('TTS output path must be inside outputRoot');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const wav = await this.#spawn(['--model', this.modelPath, '--output_file', outputPath], request.text);
    const stat = await fs.stat(outputPath);
    if (!stat.isFile() || stat.size === 0) throw new Error('Piper produced an empty output file');
    return {
      artifacts: [{
        id: request.artifactId || `${context.runId}-audio`,
        versionId: request.versionId || `${context.runId}-v1`,
        kind: 'narration',
        storageUri: outputPath,
        mediaType: 'audio/wav',
        source: 'piper',
        inputVersionIds: context.inputVersionIds,
        metadata: { bytes: stat.size, voiceModel: this.model },
      }],
      usage: { inputCharacters: request.text.length },
      estimatedCost: 0,
      actualCost: 0,
      currency: 'USD',
      providerLog: { output: wav.slice(-2000) },
    };
  }

  async #spawn(args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      timer.unref();
      child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString('utf8')).slice(-8192); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(Object.assign(new Error(`Piper failed (code=${code}, signal=${signal || 'none'}): ${stderr.slice(-3000)}`), { code: 'PROVIDER_FAILED' }));
      });
      child.stdin.end(input);
    });
  }
}

module.exports = { PiperTtsProvider, isPathInside: inside };
