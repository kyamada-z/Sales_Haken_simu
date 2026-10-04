// Authentication is enforced by Vercel Deployment Protection, before this handler.
// Enable AI only AFTER verifying protection on all preview URLs and API paths.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const fail = (status, error) => res.status(status).json({ error });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(405, 'POSTのみ利用できます。');
  }
  // Fail closed. Production and local deployments cannot call the paid API.
  if (process.env.VERCEL_ENV !== 'preview' || process.env.AI_ENABLED !== 'true' || !process.env.OPENAI_API_KEY) {
    return fail(503, 'AI機能は設定中です。管理者にお問い合わせください。');
  }
  // CSRF defense; this is NOT a substitute for Deployment Protection.
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin !== `https://${req.headers.host}`) {
    return fail(403, 'この送信元からは利用できません。');
  }
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    return fail(415, 'JSON形式で送信してください。');
  }
  let body;
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!raw || Buffer.byteLength(raw, 'utf8') > 64000) return fail(413, '会話が長すぎます。新しいレポートを作成してください。');
    body = JSON.parse(raw);
  } catch {
    return fail(400, '送信内容を確認してください。');
  }
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 24 ||
      messages[0]?.role !== 'user' || messages.at(-1)?.role !== 'user' ||
      messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 12000) ||
      messages.reduce((n, m) => n + m.content.length, 0) > 24000) {
    return fail(400, '会話が長すぎるか、形式が不正です。新しいレポートを作成してください。');
  }
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        instructions: 'あなたは派遣事業の経営分析を支援します。日本語で簡潔に回答し、計算上の事実と推測を区別してください。入力にない数値や出典を捏造しないでください。プレーンテキストで回答してください。',
        input: messages.map(({ role, content }) => ({ role, content })),
        reasoning: { effort: 'low' },
        max_output_tokens: 4000,
        store: false,
      }),
      signal: AbortSignal.timeout(55000),
    });
    if (!response.ok) {
      // Do not expose provider response bodies or credentials to browsers/logs.
      return fail(response.status === 429 ? 429 : 502,
        response.status === 429 ? '利用上限または混雑のため停止しました。時間をおいてお試しください。' : 'AIに接続できません。管理者がAPI設定を確認する必要があります。');
    }
    const data = await response.json();
    const text = data.output?.flatMap(item => item.type === 'message' ? item.content || [] : [])
      .filter(item => item.type === 'output_text').map(item => item.text).join('\n');
    if (data.status !== 'completed' || !text) return fail(502, '回答を完了できませんでした。質問を短くしてお試しください。');
    return res.status(200).json({ text });
  } catch {
    return fail(502, 'AIとの通信が完了しませんでした。時間をおいてお試しください。');
  }
}
