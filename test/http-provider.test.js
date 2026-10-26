const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpJsonProvider, openAiCompatibleChatProvider } = require('../src/pipeline/http-provider');

test('HttpJsonProvider normalizes successful JSON responses', async () => {
  const provider = new HttpJsonProvider({
    name: 'test', endpoint: 'https://provider.invalid', fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    parse: (body) => ({ artifacts: [{ kind: 'text', content: body.ok ? 'yes' : 'no' }] }),
  });
  const result = await provider.execute({});
  assert.equal(result.artifacts[0].content, 'yes');
});

test('HttpJsonProvider retries retryable failures', async () => {
  let calls = 0;
  const provider = new HttpJsonProvider({
    name: 'test', endpoint: 'https://provider.invalid', maxAttempts: 2,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? new Response('busy', { status: 503 }) : new Response('{"ok":true}', { status: 200 });
    },
    parse: (body) => ({ artifacts: [{ kind: 'json', content: body }] }),
  });
  const result = await provider.execute({});
  assert.equal(calls, 2);
  assert.equal(result.artifacts[0].content.ok, true);
});

test('OpenAI-compatible adapter builds a provider result', async () => {
  const provider = openAiCompatibleChatProvider({ endpoint: 'https://provider.invalid/v1/chat/completions', apiKey: 'secret', model: 'test-model' });
  provider.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: { total_tokens: 1 } }), { status: 200 });
  };
  const result = await provider.execute({ prompt: 'hello' });
  assert.equal(result.artifacts[0].content, 'hello');
});
