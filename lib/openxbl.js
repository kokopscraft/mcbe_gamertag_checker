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
  // true にすると、受け取った応答を加工せずに rawLog へ記録する(診断用)
  captureRaw = false,
  rawLimit = 300000,
}) {
  if (!apiKey) throw new Error('OPENXBL_API_KEY が設定されていません');
  const base = baseUrl.replace(/\/+$/, '');
  let calls = 0;
  const rawLog = [];

  // 記録には本名を残さない(診断情報を共有しても漏れないように)
  function record(method, path, status, text, requestBody) {
    if (!captureRaw) return;
    let body;
    try {
      body = text ? maskRealNames(JSON.parse(text)) : null;
    } catch {
      const head = text.length > rawLimit ? `${text.slice(0, rawLimit)}…(以下省略)` : text;
      body = maskRealNamesInText(head);
    }
    if (typeof body === 'object' && body !== null && text.length > rawLimit) {
      body = {
        truncated: true,
        note: `応答が${text.length}文字と長いため先頭だけ表示`,
        head: maskRealNamesInText(text.slice(0, rawLimit)),
      };
    }
    rawLog.push({ method, path, status, ...(requestBody ? { requestBody } : {}), body });
  }

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
      record(method, path, res.status, text, body);
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        throw new OpenXblError(res.status, `OpenXBL ${method} ${path} が ${res.status} を返しました`, data ?? text.slice(0, 300));
      }
      return unwrapEnvelope(data, method, path);
    } catch (err) {
      if (err?.name === 'AbortError') {
        record(method, path, 'timeout', '', body);
        throw new OpenXblError(504, 'OpenXBL の応答がタイムアウトしました');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get callCount() {
      return calls;
    },
    get rawLog() {
      return rawLog;
    },
    searchPlayers: (gamertag) => request('GET', `/search/${encodeURIComponent(gamertag)}`),
    getAccount: (xuid) => request('GET', `/account/${encodeURIComponent(xuid)}`),
    // ゲーム履歴(実績の進み具合つき)
    getTitles: (xuid) => request('GET', `/achievements/player/${encodeURIComponent(xuid)}`),
    // ゲーム履歴(上が読めなかったときの予備)
    getTitleHistory: (xuid) => request('GET', `/player/titleHistory/${encodeURIComponent(xuid)}`),
    // 1タイトル分の実績一覧(履歴に実績の数が含まれていなかったときに使う)
    getTitleAchievements: (xuid, titleId) =>
      request('GET', `/achievements/player/${encodeURIComponent(xuid)}/${encodeURIComponent(titleId)}`),
    getStats: (body) => request('POST', '/player/stats', body),
  };
}

// ---- 本名の伏せ字 ----

export const MASK = '######';
const REAL_NAME_KEY = /^realname/i; // realName, RealName, RealNameOverride など
const GAMERTAG_KEYS = ['gamertag', 'modernGamertag', 'uniqueModernGamertag'];

const isFilled = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 応答の中の本名を ###### に置き換えた複製を返す(元のデータは変えない)。
 * - キー名が realName / RealNameOverride などの値
 * - { id: "RealName…", value: "…" } 形式の設定値
 * - displayName がゲーマータグのどれとも違う場合(本名が表示名に使われていることがあるため)
 * 空欄や null は、本名が入っていないのでそのまま残します。
 */
export function maskRealNames(value) {
  if (Array.isArray(value)) return value.map(maskRealNames);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REAL_NAME_KEY.test(k) && isFilled(v) ? MASK : maskRealNames(v);
  }
  if (typeof out.id === 'string' && REAL_NAME_KEY.test(out.id) && isFilled(out.value)) out.value = MASK;
  if (isFilled(out.displayName)) {
    const tags = GAMERTAG_KEYS.map((key) => value[key]).filter(isFilled).map((s) => s.toLowerCase());
    if (tags.length > 0 && !tags.includes(out.displayName.toLowerCase())) out.displayName = MASK;
  }
  return out;
}

/** JSON として読めない(または途中で切った)応答の文字列から本名を伏せる。 */
export function maskRealNamesInText(text) {
  if (typeof text !== 'string' || !text) return text;
  const str = '"((?:[^"\\\\]|\\\\.)+)"';
  return text
    .replace(new RegExp(`("[Rr]eal[Nn]ame\\w*"\\s*:\\s*)${str}`, 'g'), `$1"${MASK}"`)
    .replace(new RegExp(`("id"\\s*:\\s*"[Rr]eal[Nn]ame\\w*"\\s*,\\s*"value"\\s*:\\s*)${str}`, 'g'), `$1"${MASK}"`);
}

const ENVELOPE_KEYS = new Set(['content', 'code', 'headers', 'status', 'message', 'success']);

/**
 * { content: {...}, code: 200 } のような包み紙を外す。
 * content が JSON 文字列のときは読み込み、code が 400 以上ならエラーとして扱う。
 */
export function unwrapEnvelope(data, method = 'GET', path = '') {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('content' in data)) return data;
  if (!Object.keys(data).every((k) => ENVELOPE_KEYS.has(k))) return data;
  const code = typeof data.code === 'number' ? data.code : parseInt(data.code, 10);
  let content = data.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      // JSON でなければ文字列のまま
    }
  }
  if (Number.isFinite(code) && code >= 400) {
    throw new OpenXblError(code, `OpenXBL ${method} ${path} が ${code} を返しました`, content);
  }
  return content;
}
