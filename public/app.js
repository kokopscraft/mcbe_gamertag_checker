// 画面側の処理。サーバー(/api/lookup)の結果を表示するだけで、API キーは持ちません。

const form = document.getElementById('lookup-form');
const input = document.getElementById('gamertag');
const submit = document.getElementById('submit');
const resultEl = document.getElementById('result');

// 要素を作る小さなヘルパー(利用者データは必ず textContent で入れる)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const nf = new Intl.NumberFormat('ja-JP');

function formatHours(minutes) {
  if (minutes == null) return null;
  const hours = minutes / 60;
  if (hours < 1) return '1時間未満';
  return `約${hours < 10 ? hours.toFixed(1) : nf.format(Math.round(hours))}時間`;
}

function formatDate(iso, withTime = false) {
  if (!iso) return '記録なし';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '記録なし';
  return d.toLocaleString('ja-JP', withTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' });
}

const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

const CONFIDENCE = {
  high: { chip: '信頼度 高', text: '3項目すべてを取得できました。' },
  medium: { chip: '信頼度 中', text: 'プレイ時間を取得できなかったため、2項目で計算しました。' },
  low: { chip: '信頼度 低', text: '取得できた項目が少ないか推定を含むため、参考程度にしてください。' },
};

// 英字の小見出し + 下線つき見出し
function sectionHeading(eyebrow, title) {
  return h('div', {},
    h('p', { class: 'eyebrow' }, eyebrow),
    h('h2', { class: 'list-heading' }, title));
}

function renderLoading(query) {
  resultEl.replaceChildren(h('p', { class: 'loading' }, `「${query}」を照会しています…`));
}

// 診断情報: OpenXBL から受け取った応答をすべてそのまま表示する(原因調べ用)
function renderDiagnostics(query) {
  const params = new URLSearchParams({ gamertag: query, debug: '1' });
  const apiUrl = `/api/lookup?${params}`;
  const box = h('div', { class: 'diagnostics' });
  const button = h('button', {
    type: 'button',
    class: 'text-link',
    onclick: async () => {
      button.disabled = true;
      button.textContent = '診断情報を取得中…';
      try {
        const res = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
        const text = await res.text();
        let pretty = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // JSON でなければそのまま
        }
        const copy = h('button', {
          type: 'button',
          class: 'text-link',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(pretty);
              copy.textContent = 'コピーしました';
            } catch {
              copy.textContent = 'コピーできませんでした。下の枠から選択してください';
            }
          },
        }, '全文をコピー');
        box.replaceChildren(
          h('p', {}, `HTTP ${res.status}。「raw」にOpenXBLから受け取った応答がすべて入っています。検索結果にはほかのプレイヤーの名前も含まれるので、共有するときは注意してください。`),
          h('div', { class: 'diagnostics-actions' },
            copy,
            h('a', { class: 'text-link', href: apiUrl, target: '_blank', rel: 'noopener' }, '別のタブで開く')),
          h('pre', {}, pretty));
      } catch {
        box.replaceChildren(h('p', {}, '診断情報を取得できませんでした。'));
      }
    },
  }, '診断情報を表示');
  box.append(button);
  return box;
}

function renderError(message, query) {
  resultEl.replaceChildren(
    h('div', { class: 'card message-card' },
      h('p', { class: 'eyebrow' }, 'Error'),
      h('h2', { class: 'error-title' }, '照会できませんでした'),
      h('p', {}, message),
      query ? renderDiagnostics(query) : null));
}

function renderNotFound(data) {
  const searched = (data.searchedAs ?? []).filter((t) => t !== data.query);
  const card = h('div', { class: 'card message-card' },
    h('p', { class: 'eyebrow' }, 'Not found'),
    h('h2', {}, data.query),
    h('p', {}, 'このゲーマータグのアカウントは見つかりませんでした。'),
    searched.length ? h('p', {}, `検索には「${searched.join('」「')}」を使いました。`) : null);
  if (data.candidates?.length) {
    card.append(
      h('p', {}, '似た名前のアカウント'),
      h('div', { class: 'candidates' },
        data.candidates.map((c) => h('button', { type: 'button', onclick: () => run(c) }, c))));
  }
  card.append(renderDiagnostics(data.query));
  resultEl.replaceChildren(card, renderMeta(data));
}

function renderIdentity(data) {
  const p = data.profile;
  const name = p.uniqueGamertag || p.gamertag || data.query;
  const sub = [`XUID ${p.xuid}`];
  if (p.tenureYears != null) sub.push(`Xbox歴 ${p.tenureYears}年`);
  const repBad = data.score?.reputationFactor < 1;
  const avatar = p.gamerpic
    ? h('img', { src: p.gamerpic, alt: '', width: 64, height: 64, referrerpolicy: 'no-referrer', loading: 'lazy' })
    : h('div', { class: 'avatar-fallback', 'aria-hidden': 'true' });
  return h('div', { class: 'identity' },
    avatar,
    h('div', {},
      h('div', { class: 'chips' },
        h('span', { class: 'chip' }, 'アカウントあり'),
        p.reputation ? h('span', { class: `chip ${repBad ? 'danger' : 'muted'}` }, p.reputation) : null),
      h('h2', {}, name),
      h('p', { class: 'sub' }, sub.join('、'))));
}

function renderVerdict(score) {
  if (score.status === 'undetermined') {
    return h('div', { class: 'verdict tone-caution' },
      h('div', { class: 'score-number undetermined' }, '判定不能'),
      h('div', { class: 'verdict-text' },
        h('p', { class: 'confidence' }, 'ゲーム履歴を読めないため、安全度を計算できません。')));
  }
  const conf = CONFIDENCE[score.confidence] ?? CONFIDENCE.low;
  const segments = Array.from({ length: 10 }, (_, i) => {
    const fill = Math.max(0, Math.min(1, (score.score - i * 10) / 10));
    return h('span', { style: `--fill:${fill}` });
  });
  return h('div', { class: `verdict tone-${score.band.tone}` },
    h('div', { class: 'score-number', 'aria-label': `安全度 ${score.score}パーセント` },
      String(score.score), h('span', { class: 'unit', 'aria-hidden': 'true' }, '%')),
    h('div', { class: 'verdict-text' },
      h('div', { class: 'chips' }, h('span', { class: 'chip muted' }, conf.chip)),
      h('div', { class: 'band' }, `安全度 ${score.band.label}`),
      h('p', { class: 'confidence' }, conf.text)),
    h('div', { class: 'meter', role: 'img', 'aria-label': `10段階中${Math.round(score.score / 10)}段階` }, segments));
}

function renderNotes(data) {
  if (!data.notes?.length) return null;
  return h('ul', { class: 'notes' },
    data.notes.map((n) => h('li', { class: `note-${n.tone}` }, n.text)));
}

function partValue(part, data) {
  const mc = data.history?.minecraft;
  if (part.key === 'achievements') {
    if (!part.available) return null;
    const best = mc?.titles?.find((t) => t.titleId === mc.bestTitleId);
    if (!best) return 'Minecraftの記録なし';
    return `${best.currentAchievements} / ${best.totalAchievements}(${pct(best.rate)})`;
  }
  if (part.key === 'playtime') {
    return part.available ? formatHours(data.playtime?.minutes) : null;
  }
  if (part.key === 'gamerscore') {
    return part.available ? nf.format(data.profile.gamerscore) : null;
  }
  return null;
}

function renderBreakdown(data) {
  const s = data.score;
  const rows = s.parts.map((part) => {
    const value = partValue(part, data);
    return h('tr', {},
      h('td', {}, part.label),
      h('td', { class: value == null ? 'missing' : '' }, value ?? '取得できず'),
      h('td', { class: 'num' }, part.effectiveWeight == null ? 'なし' : (part.effectiveWeight * 100).toFixed(1)),
      h('td', { class: 'num' }, part.contribution == null ? 'なし' : part.contribution.toFixed(1)));
  });
  if (s.status === 'scored' && s.reputationFactor !== 1) {
    rows.push(h('tr', {},
      h('td', {}, 'Xboxの評判による補正'),
      h('td', {}, data.profile.reputation ?? ''),
      h('td', { class: 'num' }, ''),
      h('td', { class: 'num' }, `×${s.reputationFactor}`)));
  }
  if (s.status === 'scored') {
    rows.push(h('tr', { class: 'total' },
      h('th', { scope: 'row' }, '合計'),
      h('td', {}, ''),
      h('td', { class: 'num' }, '100.0'),
      h('td', { class: 'num' }, String(s.score))));
  }
  return h('section', {},
    sectionHeading('Breakdown', '内訳'),
    h('div', { class: 'card list-card' },
      h('div', { class: 'table-wrap' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', { scope: 'col' }, '項目'),
            h('th', { scope: 'col' }, '値'),
            h('th', { scope: 'col', class: 'num' }, '配点'),
            h('th', { scope: 'col', class: 'num' }, '得点'))),
          h('tbody', {}, rows)))));
}

function renderTitles(data) {
  const titles = data.history?.minecraft?.titles ?? [];
  if (!data.history?.visible || titles.length === 0) return null;
  const perTitle = data.playtime?.perTitle ?? {};
  return h('section', {},
    sectionHeading('Platforms', '機種ごとのMinecraftの記録'),
    h('div', { class: 'card list-card' },
      h('div', { class: 'table-wrap' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', { scope: 'col' }, '機種'),
            h('th', { scope: 'col', class: 'num' }, '実績'),
            h('th', { scope: 'col', class: 'num' }, 'プレイ時間'),
            h('th', { scope: 'col', class: 'num' }, '最終プレイ'))),
          h('tbody', {}, titles.map((t) => {
            const where = t.platform ?? (t.devices.length ? t.devices.join('、') : t.name);
            const minutes = perTitle[t.titleId];
            return h('tr', {},
              h('td', { title: `${t.name}(タイトルID ${t.titleId})` }, where),
              h('td', { class: 'num' }, `${t.currentAchievements} / ${t.totalAchievements}`),
              h('td', { class: 'num' }, minutes != null ? formatHours(minutes) : '取得できず'),
              h('td', { class: 'num' }, formatDate(t.lastPlayed)));
          }))))));
}

function renderMeta(data) {
  const parts = [`取得 ${formatDate(data.fetchedAt, true)}`];
  if (data.cached) parts.push('保存済みの結果を表示中');
  else if (data.apiCalls != null) parts.push(`OpenXBLを${data.apiCalls}回呼び出し`);
  return h('div', { class: 'meta' },
    h('span', {}, parts.join('、')),
    h('button', { type: 'button', class: 'text-link', onclick: () => run(data.query, true) }, '最新の情報で再取得'));
}

function renderFound(data) {
  const summary = h('div', { class: 'card summary-card' },
    renderIdentity(data),
    renderVerdict(data.score),
    renderNotes(data));
  resultEl.replaceChildren(...[
    summary,
    renderBreakdown(data),
    renderTitles(data),
    renderMeta(data),
    renderDiagnostics(data.query),
  ].filter(Boolean));
}

// 結果の表示ごとに登場の動きをやり直す
function replay() {
  resultEl.style.animation = 'none';
  void resultEl.offsetWidth;
  resultEl.style.animation = '';
}

let inFlight = null;

async function run(query, refresh = false) {
  const q = String(query ?? '').trim();
  if (!q) {
    renderError('ゲーマータグを入力してください。');
    input.focus();
    return;
  }
  input.value = q;
  const url = new URL(location.href);
  url.searchParams.set('q', q);
  url.hash = '';
  history.replaceState(null, '', url);

  inFlight?.abort();
  const ctrl = new AbortController();
  inFlight = ctrl;
  submit.disabled = true;
  submit.textContent = '照会中…';
  renderLoading(q);

  try {
    const params = new URLSearchParams({ gamertag: q });
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/lookup?${params}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || !data) {
      renderError(data?.message ?? `サーバーがエラーを返しました(${res.status})。`, res.status === 400 ? null : q);
    } else if (!data.found) {
      renderNotFound(data);
    } else {
      renderFound(data);
    }
    replay();
  } catch (e) {
    if (e.name === 'AbortError') return;
    renderError('サーバーに接続できませんでした。ネットワークを確認して、もう一度照会してください。');
  } finally {
    if (inFlight === ctrl) {
      inFlight = null;
      submit.disabled = false;
      submit.textContent = '照会する';
    }
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(input.value);
});

const initial = new URL(location.href).searchParams.get('q');
if (initial) run(initial);
else input.focus();
