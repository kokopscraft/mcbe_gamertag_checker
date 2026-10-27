// GET /api/lookup?gamertag=...&refresh=1
// OpenXBL への中継・キャッシュ・エラーの整形を担当します。

import { createOpenXblClient, DEFAULT_OPENXBL_BASE, OpenXblError } from '../../lib/openxbl.js';
import { lookupGamertag, validateGamertag } from '../../lib/lookup-core.js';
import { parseExtraTitleIds } from '../../lib/minecraft.js';

const CACHE_VERSION = 'v1';

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

  const refresh = url.searchParams.get('refresh') === '1';
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
  });

  try {
    const result = await lookupGamertag(v.value, {
      client,
      extraTitleIds: parseExtraTitleIds(env.EXTRA_MINECRAFT_TITLE_IDS),
    });
    const body = { ...result, fetchedAt: new Date().toISOString(), apiCalls: client.callCount };
    if (env.CACHE) {
      try {
        await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: cacheTtl(env) });
      } catch {
        // 書き込み失敗は無視
      }
    }
    return json(200, { ...body, cached: false });
  } catch (e) {
    if (e instanceof OpenXblError) {
      if (e.status === 429) {
        return json(429, {
          error: 'rate_limited',
          message: 'OpenXBLの利用上限に達しました。1時間ほど待ってから、もう一度照会してください。',
        });
      }
      if (e.status === 401 || e.status === 403) {
        return json(502, {
          error: 'api_key_rejected',
          message: 'OpenXBLがAPIキーを受け付けませんでした。キーが正しいか、xbl.io のダッシュボードで確認してください。',
        });
      }
      if (e.status === 504) {
        return json(504, { error: 'timeout', message: 'OpenXBLの応答が10秒以内に返りませんでした。もう一度照会してください。' });
      }
      return json(502, {
        error: 'upstream_error',
        message: `OpenXBLがエラーを返しました(${e.status})。時間をおいて再度照会してください。`,
      });
    }
    return json(500, { error: 'internal_error', message: 'サーバー内部で処理に失敗しました。' });
  }
}
