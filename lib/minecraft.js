// ゲーム履歴から Minecraft(統合版)のタイトルを拾い出す処理。
// 統合版の実績は機種ごとに別タイトルとして記録されるため、複数のタイトルをまとめて扱います。

// 確認できた統合版のタイトルID(名前による判定の補助)。
// 追加したい ID は環境変数 EXTRA_MINECRAFT_TITLE_IDS(カンマ区切り)で渡せます。
export const KNOWN_BEDROCK_TITLE_IDS = Object.freeze({
  1828326430: 'Xbox',
  896928775: 'Windows(旧版)',
  1794566092: 'Windows(GDK版)',
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
  // 実績の仕組みがないタイトル(Java 版のランチャーなど)は除外
  const a = title.achievement ?? {};
  return (toInt(a.totalAchievements) ?? 0) > 0 || (toInt(a.currentAchievements) ?? 0) > 0;
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
        rate: Math.min(1, current / total),
        lastPlayed: t.titleHistory?.lastTimePlayed ?? null,
      };
    })
    .sort((x, y) => y.rate - x.rate);

  const best = picked[0] ?? null;
  const lastPlayed = picked
    .map((t) => t.lastPlayed)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    titles: picked,
    bestRate: best ? best.rate : 0,
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
