/**
 * Cloudflare Worker: Door State Receiver & Viewer
 *
 * - POST /api/status  -> KV に最新ステータス（state, elapsed, updatedAt）を保存
 * - GET  /api/status  -> KV から最新ステータスを JSON で返す
 * - GET  /            -> ステータス表示用 HTML ページ（経過秒数をライブ表示）
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
  if (body === null || (body.state !== 0 && body.state !== 1)) {
    return jsonResponse({ error: 'Bad Request: state must be 0 or 1' }, 400);
  }

  const elapsed =
    typeof body.elapsed === 'number' && Number.isFinite(body.elapsed) && body.elapsed >= 0
      ? Math.floor(body.elapsed)
      : 0;

  const record = {
    state: body.state,
    elapsed,
    updatedAt: new Date().toISOString()
  };

  await env.DOOR_STATE.put(KV_KEY, JSON.stringify(record));

  return jsonResponse({ ok: true, record });
}

async function handleGet(env) {
  const raw = await env.DOOR_STATE.get(KV_KEY);
  if (!raw) {
    return jsonResponse({ state: null, elapsed: null, elapsedSeconds: null, updatedAt: null });
  }

  const record = JSON.parse(raw);
  return jsonResponse({
    ...record,
    elapsedSeconds: computeElapsedSeconds(record)
  });
}

/**
 * 保存時点の elapsed に、保存からの経過時間を足して現在の経過秒数を求める。
 */
function computeElapsedSeconds(record) {
  if (!record || record.state !== 1) return 0;
  const base = typeof record.elapsed === 'number' ? record.elapsed : 0;
  const updatedAtMs = record.updatedAt ? new Date(record.updatedAt).getTime() : Date.now();
  const drift = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
  return base + drift;
}

async function handlePage(env) {
  const raw = await env.DOOR_STATE.get(KV_KEY);
  const data = raw ? JSON.parse(raw) : { state: null, elapsed: null, updatedAt: null };

  const stateText =
    data.state === 0 ? 'CLOSED' :
    data.state === 1 ? 'OPEN' :
    'UNKNOWN';

  const subText =
    data.state === 0 ? 'ドアは閉まっています' :
    data.state === 1 ? 'ドアが開放されています' :
    'データを受信していません';

  const themeClass =
    data.state === 1 ? 'open' :
    data.state === 0 ? 'closed' :
    'unknown';

  const updatedText = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : 'No data';

  // ページ読み込み時点の経過秒数をサーバー側で計算し、以降はブラウザ側でカウントアップする
  const baseElapsed = computeElapsedSeconds(data);
  const updatedAtMs = data.updatedAt ? new Date(data.updatedAt).getTime() : null;

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
    .elapsed {
      font-size: 2rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      margin: 0.25rem 0 0.5rem;
      color: #111827;
      min-height: 2.4rem;
    }
    .elapsed.open { color: #16a34a; }
    .sub { color: #6b7280; font-size: 1rem; margin-bottom: 1.5rem; }
    .time { color: #9ca3af; font-size: 0.875rem; }
    .stale { color: #f59e0b; font-size: 0.875rem; margin-top: 0.5rem; min-height: 1.1rem; }
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
    <div class="elapsed ${themeClass}" id="elapsed"></div>
    <div class="sub">${subText}</div>
    <div class="time">最終更新: ${updatedText}</div>
    <div class="stale" id="stale"></div>
  </div>
  <script>
    const state = ${data.state === null ? 'null' : data.state};
    const updatedAtMs = ${updatedAtMs === null ? 'null' : updatedAtMs};
    const baseElapsed = ${baseElapsed};
    const STALE_AFTER_MS = 60000;

    function formatElapsed(sec) {
      if (sec < 60) return sec + ' 秒';
      if (sec < 3600) return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
      return Math.floor(sec / 3600) + ' 時間 ' + Math.floor((sec % 3600) / 60) + ' 分';
    }

    function tick() {
      const elapsedEl = document.getElementById('elapsed');
      const staleEl = document.getElementById('stale');

      if (state === 1 && updatedAtMs !== null) {
        const sec = baseElapsed + Math.floor((Date.now() - updatedAtMs) / 1000);
        elapsedEl.textContent = formatElapsed(Math.max(0, sec)) + ' 経過';
        staleEl.textContent =
          Date.now() - updatedAtMs > STALE_AFTER_MS ? '（デバイスからの更新が停止しています）' : '';
      } else if (state === 0) {
        elapsedEl.textContent = '';
        staleEl.textContent =
          updatedAtMs !== null && Date.now() - updatedAtMs > STALE_AFTER_MS
            ? '（デバイスからの更新が停止しています）'
            : '';
      } else {
        elapsedEl.textContent = '';
        staleEl.textContent = '';
      }
    }

    tick();
    setInterval(tick, 1000);
    // 1 分ごとにサーバーから最新状態を取得して再同期
    setInterval(() => location.reload(), 60000);
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
