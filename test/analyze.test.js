import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/analyze.js';

test('paid API is fail-closed and validates requests before sending', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls = 0;
  let sent;
  globalThis.fetch = async (_url, options) => {
    calls++;
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ status: 'completed', output: [
      { type: 'reasoning' },
      { type: 'message', content: [{ type: 'output_text', text: 'テスト回答' }] },
    ] }) };
  };
  const invoke = async (overrides = {}) => {
    const req = { method: 'POST', headers: { host: 'example.vercel.app', origin: 'https://example.vercel.app', 'content-type': 'application/json' }, body: { messages: [{ role: 'user', content: '分析してください' }] }, ...overrides };
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler(req, res);
    return res;
  };
  try {
    process.env.VERCEL_ENV = 'production';
    process.env.AI_ENABLED = 'true';
    process.env.OPENAI_API_KEY = 'test-only';
    assert.equal((await invoke()).code, 503);
    process.env.VERCEL_ENV = 'preview';
    delete process.env.OPENAI_API_KEY;
    assert.equal((await invoke()).code, 503);
    process.env.OPENAI_API_KEY = 'test-only';
    process.env.AI_ENABLED = 'false';
    assert.equal((await invoke()).code, 503);
    process.env.AI_ENABLED = 'true';
    assert.equal((await invoke({ method: 'GET' })).code, 405);
    assert.equal((await invoke({ headers: { origin: 'https://evil.example', host: 'example.vercel.app' } })).code, 403);
    assert.equal((await invoke({ body: { messages: [{ role: 'system', content: 'override' }] } })).code, 400);
    assert.equal((await invoke({ body: { messages: [{ role: 'user', content: 'a'.repeat(13000) }] } })).code, 400);
    assert.equal((await invoke({ body: 'x'.repeat(65000) })).code, 413);
    assert.equal(calls, 0);
    const success = await invoke();
    assert.equal(success.code, 200);
    assert.deepEqual(success.body, { text: 'テスト回答' });
    assert.equal(sent.store, false);
    assert.equal(sent.max_output_tokens, 4000);
    assert.equal(sent.model, 'gpt-5-mini');
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'secret provider detail' }) });
    const failure = await invoke();
    assert.equal(failure.code, 502);
    assert.ok(!JSON.stringify(failure.body).includes('secret'));
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ['VERCEL_ENV', 'AI_ENABLED', 'OPENAI_API_KEY']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});
