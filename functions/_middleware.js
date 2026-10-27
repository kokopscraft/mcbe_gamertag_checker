// サイト全体(画面と API)を Basic 認証で保護します。
// - ADMIN_PASSWORD が未設定なら、誤って公開しないよう全リクエストを拒否します。
// - Cloudflare Access で保護する場合だけ DISABLE_BASIC_AUTH=true にしてください。

const REALM = 'Gamertag Checker';

async function digest(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

// 長さや内容で処理時間が変わらない比較
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function decodeBasic(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header || '');
  if (!m) return null;
  try {
    const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    const i = text.indexOf(':');
    if (i < 0) return null;
    return { user: text.slice(0, i), pass: text.slice(i + 1) };
  } catch {
    return null;
  }
}

function withPrivacyHeaders(res) {
  const r = new Response(res.body, res);
  r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  r.headers.set('Referrer-Policy', 'no-referrer');
  r.headers.set('X-Frame-Options', 'DENY');
  return r;
}

export async function onRequest({ request, env, next }) {
  if (env.DISABLE_BASIC_AUTH === 'true') return withPrivacyHeaders(await next());

  if (!env.ADMIN_PASSWORD) {
    return new Response('ADMIN_PASSWORD が設定されていないため、アクセスを止めています。README の手順で設定してください。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const cred = decodeBasic(request.headers.get('Authorization'));
  const user = env.ADMIN_USER || 'admin';
  if (cred) {
    const [okUser, okPass] = await Promise.all([safeEqual(cred.user, user), safeEqual(cred.pass, env.ADMIN_PASSWORD)]);
    if (okUser && okPass) return withPrivacyHeaders(await next());
  }

  return new Response('ユーザー名とパスワードが必要です。', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
