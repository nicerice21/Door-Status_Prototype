/**
 * Cloudflare Worker: Door State Receiver & Viewer
 *
 * - POST /api/status  -> KV に最新ステータスを保存（状態変化時のみ書き込み）
 * - GET  /api/status  -> KV から最新ステータスを JSON で返す
 * - GET  /            -> ステータス表示用 HTML ページ（KV を読まない静的シェル）
 *
 * KV namespace binding: DOOR_STATE
 * 認証: POST 時に Authorization: Bearer <TOKEN> が必要
 *
 * KV 使用量の最適化:
 * - 経過秒数は openedAt から都度計算するため、定期書き込み（ハートビート）は行わない
 * - 同一状態の再送は書き込みをスキップ
 * - ページは静的シェルを返し、可視状態のときだけ 60 秒ごとに API を読む
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
        return handlePage();
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

  const now = Date.now();
  const openedAt = body.state === 1 ? now - elapsed * 1000 : null;

  // 同一状態の再送（再接続時など）は書き込まずに既存レコードを返す
  const existingRaw = await env.DOOR_STATE.get(KV_KEY);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    if (existing.state === body.state) {
      const sameOpen =
        body.state === 1 &&
        typeof existing.openedAt === 'number' &&
        Math.abs(existing.openedAt - openedAt) < 5000;
      if (body.state === 0 || sameOpen) {
        return jsonResponse({
          ok: true,
          unchanged: true,
          record: { ...existing, elapsedSeconds: computeElapsedSeconds(existing) }
        });
      }
    }
  }

  const record = {
    state: body.state,
    openedAt,
    updatedAt: new Date(now).toISOString()
  };

  await env.DOOR_STATE.put(KV_KEY, JSON.stringify(record));

  return jsonResponse({ ok: true, record: { ...record, elapsedSeconds: computeElapsedSeconds(record) } });
}

async function handleGet(env) {
  const raw = await env.DOOR_STATE.get(KV_KEY);
  if (!raw) {
    return jsonResponse({ state: null, openedAt: null, elapsedSeconds: null, updatedAt: null });
  }

  const record = JSON.parse(raw);
  return jsonResponse({
    ...record,
    elapsedSeconds: computeElapsedSeconds(record)
  });
}

/**
 * 開放してからの経過秒数を求める。
 * 新レコードは openedAt、旧レコード（elapsed + updatedAt）にも対応する。
 */
function computeElapsedSeconds(record) {
  if (!record || record.state !== 1) return 0;

  if (typeof record.openedAt === 'number') {
    return Math.max(0, Math.floor((Date.now() - record.openedAt) / 1000));
  }

  const base = typeof record.elapsed === 'number' ? record.elapsed : 0;
  const updatedAtMs = record.updatedAt ? new Date(record.updatedAt).getTime() : Date.now();
  return base + Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
}

/**
 * 静的なページシェルを返す（KV を読まない）。
 * データはクライアント側で /api/status から取得し、経過秒数はローカルで進める。
 */
function handlePage() {
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
    <div class="status unknown" id="status">
      <span class="dot unknown" id="dot"></span><span id="stateText">UNKNOWN</span>
    </div>
    <div class="elapsed" id="elapsed"></div>
    <div class="sub" id="sub">データを受信していません</div>
    <div class="time" id="time">No data</div>
  </div>
  <script>
    const POLL_MS = 60000;
    const stateTextEl = document.getElementById('stateText');
    const statusEl = document.getElementById('status');
    const dotEl = document.getElementById('dot');
    const elapsedEl = document.getElementById('elapsed');
    const subEl = document.getElementById('sub');
    const timeEl = document.getElementById('time');

    let record = null;
    let fetchedAt = 0;

    function formatElapsed(sec) {
      if (sec < 60) return sec + ' 秒';
      if (sec < 3600) return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
      return Math.floor(sec / 3600) + ' 時間 ' + Math.floor((sec % 3600) / 60) + ' 分';
    }

    const LABELS = {
      1: ['OPEN', 'open', 'ドアが開放されています'],
      0: ['CLOSED', 'closed', 'ドアは閉まっています']
    };

    function render() {
      const state = record ? record.state : null;
      const label = LABELS[state] || ['UNKNOWN', 'unknown', 'データを受信していません'];
      const [, cls, sub] = label;

      stateTextEl.textContent = label[0];
      statusEl.className = 'status ' + cls;
      dotEl.className = 'dot ' + cls;
      elapsedEl.className = 'elapsed ' + cls;
      subEl.textContent = sub;
      timeEl.textContent = record && record.updatedAt
        ? '最終更新: ' + new Date(record.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
        : 'No data';

      if (state === 1) {
        tick();
      } else {
        elapsedEl.textContent = '';
      }
    }

    function tick() {
      if (!record || record.state !== 1) return;
      const base = typeof record.elapsedSeconds === 'number' ? record.elapsedSeconds : 0;
      const sec = Math.max(0, base + Math.floor((Date.now() - fetchedAt) / 1000));
      elapsedEl.textContent = formatElapsed(sec) + ' 経過';
    }

    async function refresh() {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        record = await res.json();
        fetchedAt = Date.now();
        render();
      } catch (e) {
        // 取得に失敗しても直前の表示を維持する
      }
    }

    refresh();
    setInterval(tick, 1000);
    setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60'
    }
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
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}
