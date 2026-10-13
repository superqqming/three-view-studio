// 測試用的假 Anthropic API（本工具自己的）：照官方串流格式（SSE）回傳 ai-cube-sample.json（現在的精簡格式）。
// 改寫自 assembly-unit-simulator/worker/test/mock-anthropic.mjs（那份回傳舊格式，留給組合單元用）。
// POST /__mode {mode: 'ok' | 'overloaded' | 'refusal' | 'maxtokens' | 'regionblock-once'} 切換情境；
// GET /__last 看最後收到的請求（不含圖片內容；systemHash／schemaHash 用來比對兩個入口送出的請求是否相同）。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const RESULT = readFileSync(new URL('./ai-cube-sample.json', import.meta.url), 'utf8');
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(canon(v ?? null))).digest('hex').slice(0, 16);

export function startMock(port) {
  let mode = 'ok', last = null, calls = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');            // 讓瀏覽器直接呼叫（「自己的金鑰」那條路）
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/__mode') { mode = JSON.parse(body).mode; res.end('ok'); return; }
    if (req.url === '/__last') return send(200, { last, calls });
    if (req.url.startsWith('/v1/models/') && req.method === 'GET') {
      if (req.headers['x-api-key'] !== 'test-key') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      return send(200, { type: 'model', id: decodeURIComponent(req.url.split('/').pop()), display_name: 'test', created_at: '2026-01-01T00:00:00Z' });
    }
    if (!(req.url.startsWith('/v1/messages') && req.method === 'POST')) { res.writeHead(404); res.end(); return; }
    calls++;
    const b = JSON.parse(body);
    last = {
      model: b.model, stream: b.stream, max_tokens: b.max_tokens, output_config: { effort: b.output_config?.effort, format: b.output_config?.format?.type },
      systemCache: b.system?.[0]?.cache_control?.type, systemChars: b.system?.[0]?.text?.length,
      schemaKeys: Object.keys(b.output_config?.format?.schema?.properties || {}), userText: b.messages?.[0]?.content?.find(c => c.type === 'text')?.text,
      images: b.messages?.[0]?.content?.filter(c => c.type === 'image').length, apiKey: req.headers['x-api-key'],
      systemHash: hash(b.system), schemaHash: hash(b.output_config?.format?.schema), imageHash: hash(b.messages?.[0]?.content?.filter(c => c.type === 'image')),
      browser: !!req.headers['anthropic-dangerous-direct-browser-access'],
    };
    if (mode === 'regionblock-once') { mode = 'ok'; return send(403, { error: { type: 'forbidden', message: 'Request not allowed' } }); }
    if (mode === 'overloaded') return send(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4800, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1300 } } });
    const finish = (reason, out) => { ev('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: out } }); ev('message_stop', {}); res.end(); };
    if (mode === 'refusal') return finish('refusal', 12);
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    const out = mode === 'maxtokens' ? '{"is_part_sketch": true, "message": "' : RESULT;
    for (let i = 0; i < out.length; i += 400) {
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: out.slice(i, i + 400) } });
      await new Promise(r => setTimeout(r, 20));
    }
    ev('content_block_stop', { index: 0 });
    finish(mode === 'maxtokens' ? 'max_tokens' : 'end_turn', mode === 'maxtokens' ? 32000 : 3456);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, setMode: m => fetch(`http://127.0.0.1:${port}/__mode`, { method: 'POST', body: JSON.stringify({ mode: m }) }), last: () => fetch(`http://127.0.0.1:${port}/__last`).then(x => x.json()) })));
}
