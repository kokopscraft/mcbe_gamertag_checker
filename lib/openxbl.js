// OpenXBL(https://xbl.io)の最小クライアント。
// API キーはサーバー側(Pages Functions)だけで使い、ブラウザには渡しません。

export const DEFAULT_OPENXBL_BASE = 'https://xbl.io/api/v2';

export class OpenXblError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'OpenXblError';
    this.status = status;
    this.body = body;
  }
}

export function createOpenXblClient({
  apiKey,
  baseUrl = DEFAULT_OPENXBL_BASE,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = 10000,
}) {
  if (!apiKey) throw new Error('OPENXBL_API_KEY が設定されていません');
  const base = baseUrl.replace(/\/+$/, '');
  let calls = 0;

  async function request(method, path, body) {
    calls += 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers: {
          'X-Authorization': apiKey,
          Accept: 'application/json',
          'Accept-Language': 'en-US',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        throw new OpenXblError(res.status, `OpenXBL ${method} ${path} が ${res.status} を返しました`, data ?? text.slice(0, 300));
      }
      return data;
    } catch (err) {
      if (err?.name === 'AbortError') throw new OpenXblError(504, 'OpenXBL の応答がタイムアウトしました');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get callCount() {
      return calls;
    },
    searchPlayers: (gamertag) => request('GET', `/search/${encodeURIComponent(gamertag)}`),
    getAccount: (xuid) => request('GET', `/account/${encodeURIComponent(xuid)}`),
    getTitles: (xuid) => request('GET', `/achievements/player/${encodeURIComponent(xuid)}`),
    getStats: (body) => request('POST', '/player/stats', body),
  };
}
