// ゲーム履歴から Minecraft(統合版)のタイトルを拾い出す処理。
// 統合版の実績は機種ごとに別タイトルとして記録されるため、複数のタイトルをまとめて扱います。

// 確認できた統合版のタイトルID(名前による判定の補助)。
// 追加したい ID は環境変数 EXTRA_MINECRAFT_TITLE_IDS(カンマ区切り)で渡せます。
// ※ 1794566092 は Minecraft Launcher(実績なし)なので含めない(実データで確認)
export const KNOWN_BEDROCK_TITLE_IDS = Object.freeze({
  1828326430: 'Xbox',
  896928775: 'Windows',
  1739947436: 'モバイル',
  2047319603: 'Nintendo Switch',
});

// 名前に Minecraft を含んでも統合版本体ではないタイトル
const EXCLUDED_NAME = /(dungeons|legends|story\s*mode|earth|education|launcher|preview|blast)/i;

function toInt(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function parseExtraTitleIds(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

export function isBedrockTitle(title, extraIds = []) {
  if (!title) return false;
  const id = String(title.titleId ?? '');
  if (id && (Object.prototype.hasOwnProperty.call(KNOWN_BEDROCK_TITLE_IDS, id) || extraIds.includes(id))) {
    return true;
  }
  const name = String(title.name ?? '');
  if (!/minecraft/i.test(name) || EXCLUDED_NAME.test(name)) return false;
  // 実績の情報が付いていない履歴なら、名前だけで判断する(実績は後から別に取る)
  if (!hasAchievementData(title)) return true;
  // 実績の仕組みがないタイトル(Java 版のランチャーなど)は除外
  const a = title.achievement;
  return (
    (toInt(a.totalAchievements) ?? 0) > 0 ||
    (toInt(a.currentAchievements) ?? 0) > 0 ||
    (toInt(a.totalGamerscore) ?? 0) > 0
  );
}

/** 履歴の 1 タイトルに実績の数が含まれているか。 */
export function hasAchievementData(title) {
  const a = title?.achievement;
  return Boolean(a && typeof a === 'object' && (a.currentAchievements != null || a.currentGamerscore != null));
}

function findArray(json, test) {
  const seen = new Set();
  const queue = [json];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.some((o) => o && typeof o === 'object' && test(o))) return node;
      queue.push(...node);
    } else {
      queue.push(...Object.values(node));
    }
  }
  return null;
}

/** 応答の中からゲーム履歴(titleId を持つ要素の配列)を探す。titles 直下でも入れ子でも拾う。 */
export function extractTitles(json) {
  // Xbox 360 形式の実績一覧も titleId を持つので、実績らしい要素(progressState / unlocked)は除く
  const arr = findArray(
    json,
    (o) =>
      (o.titleId != null || o.titleid != null || o.TitleId != null) &&
      o.progressState == null &&
      o.unlocked == null &&
      o.isUnlocked == null,
  );
  if (!arr) return [];
  return arr
    .filter((o) => o && typeof o === 'object')
    .map((o) => ({ ...o, titleId: String(o.titleId ?? o.titleid ?? o.TitleId ?? ''), name: o.name ?? o.titleName ?? o.Name ?? '' }))
    .filter((o) => o.titleId);
}

/**
 * 1 タイトル分の実績一覧から、解除数・総数・獲得ゲーマースコアを数える。
 * Xbox One 形式(progressState)と Xbox 360 形式(unlocked)の両方に対応。
 */
export function countAchievements(json) {
  const list = findArray(json, (o) => o.progressState != null || o.unlocked != null || o.isUnlocked != null);
  if (!list) return null;
  const items = list.filter((o) => o && typeof o === 'object');
  const achieved = items.filter(
    (o) => o.progressState === 'Achieved' || o.unlocked === true || o.isUnlocked === true,
  );
  const gamerscoreOf = (o) => {
    const reward = Array.isArray(o.rewards) ? o.rewards.find((r) => /gamerscore/i.test(String(r?.type ?? ''))) : null;
    return toInt(reward?.value) ?? toInt(o.gamerscore) ?? 0;
  };
  // 一覧が分割されている場合は総数の記載を優先
  const totalRecords = toInt(json?.pagingInfo?.totalRecords) ?? toInt(json?.paginginfo?.totalRecords);
  const out = {
    currentAchievements: achieved.length,
    totalAchievements: Math.max(items.length, totalRecords ?? 0),
    currentGamerscore: achieved.reduce((s, o) => s + gamerscoreOf(o), 0),
  };
  // 一覧がすべて揃っているときだけ、満点のゲーマースコアも数える
  const complete = totalRecords == null || totalRecords <= items.length;
  const totalGamerscore = items.reduce((s, o) => s + gamerscoreOf(o), 0);
  if (complete && totalGamerscore > 0) out.totalGamerscore = totalGamerscore;
  return out;
}

/**
 * 1 タイトルの達成率。獲得ゲーマースコア ÷ 満点ゲーマースコア を使う(Xbox アプリの % 表示と同じ)。
 * 満点が取れないときだけ、解除数 ÷ 総数(取れなければ defaultTotal)で代用する。
 */
export function achievementRateOf(achievement, defaultTotal = 133) {
  const a = achievement ?? {};
  const gs = toInt(a.currentGamerscore);
  const gsTotal = toInt(a.totalGamerscore);
  if (gs != null && gsTotal != null && gsTotal > 0) {
    return { rate: Math.min(1, gs / gsTotal), basis: 'gamerscore' };
  }
  const current = toInt(a.currentAchievements) ?? 0;
  const totalRaw = toInt(a.totalAchievements);
  const total = totalRaw && totalRaw > 0 ? totalRaw : defaultTotal;
  return { rate: Math.min(1, current / total), basis: 'count' };
}

/**
 * @param {Array} titles  OpenXBL /achievements/player/{xuid} の titles
 * @returns {{titles: Array, bestRate: number, bestTitleId: string|null, minecraftGamerscore: number, lastPlayed: string|null}}
 */
export function summarizeMinecraft(titles, { defaultTotalAchievements = 133, extraIds = [] } = {}) {
  const picked = (Array.isArray(titles) ? titles : [])
    .filter((t) => isBedrockTitle(t, extraIds))
    .map((t) => {
      const a = t.achievement ?? {};
      const current = toInt(a.currentAchievements) ?? 0;
      const totalRaw = toInt(a.totalAchievements);
      const total = totalRaw && totalRaw > 0 ? totalRaw : defaultTotalAchievements;
      const known = hasAchievementData(t);
      const { rate, basis } = achievementRateOf(a, defaultTotalAchievements);
      return {
        titleId: String(t.titleId ?? ''),
        name: String(t.name ?? 'Minecraft'),
        platform: KNOWN_BEDROCK_TITLE_IDS[String(t.titleId ?? '')] ?? null,
        devices: Array.isArray(t.devices) ? t.devices : [],
        currentAchievements: current,
        totalAchievements: total,
        totalFromApi: Boolean(totalRaw && totalRaw > 0),
        currentGamerscore: toInt(a.currentGamerscore) ?? 0,
        totalGamerscore: toInt(a.totalGamerscore),
        // 実績の数が取れなかったタイトルは、達成率の計算に使わない
        achievementKnown: known,
        rate: known ? rate : null,
        rateBasis: known ? basis : null,
        lastPlayed: t.titleHistory?.lastTimePlayed ?? t.lastTimePlayed ?? t.lastPlayed ?? null,
      };
    })
    .sort((x, y) => (y.rate ?? -1) - (x.rate ?? -1));

  const best = picked.find((t) => t.rate != null) ?? null;
  const lastPlayed = picked
    .map((t) => t.lastPlayed)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    titles: picked,
    // Minecraft がなければ 0、あっても実績の数がどれも取れなければ null(=取得できず)
    bestRate: picked.length === 0 ? 0 : best ? best.rate : null,
    bestTitleId: best ? best.titleId : null,
    minecraftGamerscore: picked.reduce((s, t) => s + t.currentGamerscore, 0),
    lastPlayed,
  };
}

/**
 * /player/stats の応答から MinutesPlayed を探して合計する。
 * 応答の形が多少違っても拾えるよう、JSON 全体をたどって探します。
 * 見つからなければ null。
 */
export function extractMinutesPlayed(json) {
  const perKey = new Map();
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const statName = node.name ?? node.statname ?? node.statName;
    if (typeof statName === 'string' && /^minutesplayed$/i.test(statName) && node.value != null) {
      const minutes = Number(node.value);
      if (Number.isFinite(minutes) && minutes >= 0) {
        const key = String(node.titleid ?? node.titleId ?? node.scid ?? 'unknown');
        perKey.set(key, Math.max(perKey.get(key) ?? 0, minutes));
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(json);
  if (perKey.size === 0) return null;
  let total = 0;
  for (const v of perKey.values()) total += v;
  return { minutes: total, perTitle: Object.fromEntries(perKey) };
}
