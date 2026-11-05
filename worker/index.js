/**
 * Cloudflare Worker: Door State Receiver & Viewer
 *
 * - POST /api/status  -> KV に最新ステータスを保存
 * - GET  /api/status  -> KV から最新ステータスを JSON で返す
 * - GET  /            -> ステータス表示用 HTML ページ
 *
 * KV namespace binding: DOOR_STATE
 * 認証: POST 時に Authorization: Bearer <TOKEN> が必要
 */

const KV_KEY = 'current';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/status') {
        if (request.method === 'POST') {
          return await handlePost(request, env);
        }
        if (request.method === 'GET') {
          return await handleGet(env);
        }
        return methodNotAllowed();
      }

      if (url.pathname === '/') {
        return await handlePage(env);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};

async function handlePost(request, env) {
  const token = env.DOOR_STATE_TOKEN || '';
  const authHeader = request.headers.get('Authorization') || '';
  const expected = 'Bearer ' + token;
  if (token && authHeader !== expected) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await request.json().catch(() => null);
  if (body === null || typeof body.state !== 'number') {
    return jsonResponse({ error: 'Bad Request: state is required as number' }, 400);
  }

  const record = {
    state: body.state,
    updatedAt: new Date().toISOString()
  };

  await env.DOOR_STATE.put(KV_KEY, JSON.stringify(record));

  return jsonResponse({ ok: true, record });
}

async function handleGet(env) {
  const record = await env.DOOR_STATE.get(KV_KEY);
  if (!record) {
    return jsonResponse({ state: null, updatedAt: null });
  }
  return jsonResponse(JSON.parse(record));
}

async function handlePage(env) {
  const record = await env.DOOR_STATE.get(KV_KEY);
  const data = record ? JSON.parse(record) : { state: null, updatedAt: null };

  const stateText =
    data.state === 0 ? 'CLOSED' :
    data.state === 1 ? 'OPEN' :
    'UNKNOWN';

  const subText =
    data.state === 0 ? 'magnet near' :
    data.state === 1 ? 'magnet away' :
    'waiting for data...';

  const themeClass =
    data.state === 1 ? 'open' :
    data.state === 0 ? 'closed' :
    'unknown';

  const updatedText = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : 'No data';

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Door State</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f3f4f6;
    }
    .card {
      background: white;
      padding: 2.5rem;
      border-radius: 1.5rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.08);
      text-align: center;
      min-width: 320px;
      max-width: 90vw;
    }
    h1 { margin: 0 0 1rem; color: #111827; font-size: 1.5rem; }
    .status {
      font-size: 4rem;
      font-weight: 800;
      margin: 1rem 0 0.25rem;
      letter-spacing: -0.05em;
    }
    .status.open { color: #22c55e; }
    .status.closed { color: #ef4444; }
    .status.unknown { color: #6b7280; }
    .sub { color: #6b7280; font-size: 1rem; margin-bottom: 1.5rem; }
    .time { color: #9ca3af; font-size: 0.875rem; }
    .dot {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-right: 8px;
    }
    .dot.open { background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,0.2); }
    .dot.closed { background: #ef4444; box-shadow: 0 0 0 4px rgba(239,68,68,0.2); }
    .dot.unknown { background: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Door State Monitor</h1>
    <div class="status ${themeClass}">
      <span class="dot ${themeClass}"></span>${stateText}
    </div>
    <div class="sub">${subText}</div>
    <div class="time">${updatedText}</div>
  </div>
  <script>
    setInterval(() => location.reload(), 5000);
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function methodNotAllowed() {
  return new Response('Method Not Allowed', { status: 405 });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
