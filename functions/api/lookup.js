// GET /api/lookup?gamertag=...&refresh=1
// OpenXBL への中継・キャッシュ・エラーの整形を担当します。

import { createOpenXblClient, DEFAULT_OPENXBL_BASE, OpenXblError } from '../../lib/openxbl.js';
import { lookupGamertag, validateGamertag } from '../../lib/lookup-core.js';
import { parseExtraTitleIds } from '../../lib/minecraft.js';

// 結果の形を変えたら上げる(古い保存結果を使わないようにするため)
const CACHE_VERSION = 'v2';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function cacheTtl(env) {
  const n = parseInt(env.CACHE_TTL_SECONDS ?? '3600', 10);
  // Workers KV の有効期限は 60 秒以上
  return Number.isFinite(n) ? Math.max(60, n) : 3600;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const v = validateGamertag(url.searchParams.get('gamertag'));
  if (!v.ok) return json(400, { error: 'invalid_input', message: v.message });

  if (!env.OPENXBL_API_KEY) {
    return json(500, {
      error: 'missing_api_key',
      message: 'サーバーに OPENXBL_API_KEY が設定されていません。README の手順で設定してください。',
    });
  }

  // debug=1 は診断用。キャッシュを使わず、検索応答の形の要約を添えて返す
  const debug = url.searchParams.get('debug') === '1';
  const refresh = debug || url.searchParams.get('refresh') === '1';
  const cacheKey = `lookup:${CACHE_VERSION}:${v.value.toLowerCase()}`;

  if (env.CACHE && !refresh) {
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached) return json(200, { ...cached, cached: true });
    } catch {
      // キャッシュが読めなくても照会は続ける
    }
  }

  const client = createOpenXblClient({
    apiKey: env.OPENXBL_API_KEY,
    baseUrl: env.OPENXBL_BASE || DEFAULT_OPENXBL_BASE,
    captureRaw: debug,
  });

  try {
    const result = await lookupGamertag(v.value, {
      client,
      extraTitleIds: parseExtraTitleIds(env.EXTRA_MINECRAFT_TITLE_IDS),
      debug,
    });
    const body = { ...result, fetchedAt: new Date().toISOString(), apiCalls: client.callCount };
    // 診断時は、OpenXBL から受け取った応答を加工せずにすべて添える
    if (debug) body.debug = { ...(body.debug ?? {}), raw: client.rawLog };
    if (env.CACHE && !debug) {
      try {
        await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: cacheTtl(env) });
      } catch {
        // 書き込み失敗は無視
      }
    }
    return json(200, { ...body, cached: false });
  } catch (e) {
    // 診断時だけ、上流の状態と応答の先頭を添える
    const withDebug = (body) =>
      debug
        ? {
            ...body,
            debug: {
              upstreamStatus: e?.status ?? null,
              upstreamBody: typeof e?.body === 'string' ? e.body.slice(0, 300) : JSON.stringify(e?.body ?? null).slice(0, 300),
              errorName: e?.name ?? null,
              errorMessage: String(e?.message ?? '').slice(0, 200),
              raw: client.rawLog,
            },
          }
        : body;

    if (e instanceof OpenXblError) {
      if (e.status === 429) {
        return json(429, withDebug({
          error: 'rate_limited',
          message: 'OpenXBLの利用上限に達しました。1時間ほど待ってから、もう一度照会してください。',
        }));
      }
      if (e.status === 401 || e.status === 403) {
        return json(502, withDebug({
          error: 'api_key_rejected',
          message: 'OpenXBLがAPIキーを受け付けませんでした。キーが正しいか、xbl.io のダッシュボードで確認してください。',
        }));
      }
      if (e.status === 504) {
        return json(504, withDebug({ error: 'timeout', message: 'OpenXBLの応答が10秒以内に返りませんでした。もう一度照会してください。' }));
      }
      return json(502, withDebug({
        error: 'upstream_error',
        message: `OpenXBLがエラーを返しました(${e.status})。時間をおいて再度照会してください。`,
      }));
    }
    return json(500, withDebug({ error: 'internal_error', message: 'サーバー内部で処理に失敗しました。' }));
  }
}
