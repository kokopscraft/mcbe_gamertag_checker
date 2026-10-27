// ゲーマータグ 1 件を照会する一連の処理(API の呼び出し順・判定・スコア計算)。
// HTTP やキャッシュには依存しないので、テストでは偽のクライアントを渡せます。

import { computeScore, SCORE_CONFIG } from './score.js';
import {
  summarizeMinecraft,
  extractMinutesPlayed,
  extractTitles,
  countAchievements,
  hasAchievementData,
  isBedrockTitle,
} from './minecraft.js';

const MAX_GAMERTAG_LENGTH = 32;

export function validateGamertag(raw) {
  const q = String(raw ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!q) return { ok: false, message: 'ゲーマータグを入力してください。' };
  if (q.length > MAX_GAMERTAG_LENGTH) {
    return { ok: false, message: `ゲーマータグは${MAX_GAMERTAG_LENGTH}文字以内で入力してください。` };
  }
  // 制御文字やパス区切りは受け付けない
  if (/[\u0000-\u001f\u007f/\\?%]/.test(q)) {
    return { ok: false, message: 'ゲーマータグに使えない文字が含まれています。' };
  }
  return { ok: true, value: q };
}

const norm = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

function namesOf(p) {
  const names = [p.gamertag, p.modernGamertag, p.uniqueModernGamertag];
  if (p.modernGamertag && p.modernGamertagSuffix) {
    names.push(`${p.modernGamertag}#${p.modernGamertagSuffix}`);
    // 自動で作られる旧式ゲーマータグは「名前+番号」の形になることが多い
    names.push(`${p.modernGamertag}${p.modernGamertagSuffix}`);
  }
  return names.filter(Boolean).map(norm);
}

/** 検索結果の中から、入力と完全一致するアカウントを選ぶ。 */
export function findExactMatch(people, query) {
  const q = norm(query);
  const exact = people.filter((p) => p?.xuid && namesOf(p).includes(q));
  if (exact.length === 0) return { match: null, ambiguous: [] };
  // #付きの完全な名前 → 旧式ゲーマータグ の順で優先
  const unique = exact.find((p) => norm(p.uniqueModernGamertag) === q);
  const classic = exact.find((p) => norm(p.gamertag) === q);
  const match = unique ?? classic ?? exact[0];
  return { match, ambiguous: exact.length > 1 ? exact.map(displayName) : [] };
}

function displayName(p) {
  return p.uniqueModernGamertag || p.gamertag || p.modernGamertag || p.displayName || String(p.xuid);
}

/**
 * 検索に使う語を決める。
 * - 「名前#1234」は、#より前の名前で検索してから番号で絞り込む
 * - 「名前1234」で見つからなければ、末尾の数字を外した名前でもう一度検索する
 */
export function searchTermsFor(query) {
  const hash = query.indexOf('#');
  if (hash > 0) return [query.slice(0, hash).trim()];
  const m = /^(.*\D)\s*(\d{1,4})$/.exec(query);
  return m && m[1].trim() ? [query, m[1].trim()] : [query];
}

/** 応答の中からプレイヤーの配列を探す(people 直下でも、入れ子でも拾う)。 */
export function extractPeople(json) {
  if (!json || typeof json !== 'object') return [];
  const normalize = (arr) =>
    arr
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({ ...p, xuid: p.xuid ?? p.id ?? p.XUID ?? null }))
      .filter((p) => p.xuid != null);
  if (Array.isArray(json.people)) return normalize(json.people);
  const seen = new Set();
  const stack = [json];
  while (stack.length) {
    const node = stack.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      const looksLikePeople = node.some((o) => o && typeof o === 'object' && (o.xuid != null || o.gamertag != null));
      if (looksLikePeople) return normalize(node);
      stack.push(...node);
    } else {
      if (Array.isArray(node.people)) return normalize(node.people);
      stack.push(...Object.values(node));
    }
  }
  return [];
}

/** 診断用: 検索応答の形の要約(中身は最小限)。 */
export function summarizeSearch(json) {
  const people = extractPeople(json);
  const isObj = json && typeof json === 'object' && !Array.isArray(json);
  const text = (v) => (typeof v === 'string' ? v.slice(0, 200) : null);
  return {
    responseType: json === null ? 'null(JSONではない応答)' : Array.isArray(json) ? 'array' : typeof json,
    topLevelKeys: isObj ? Object.keys(json).slice(0, 30) : null,
    peopleCount: people.length,
    firstPersonKeys: people[0] ? Object.keys(people[0]).slice(0, 40) : null,
    samples: people.slice(0, 5).map((p) => ({
      xuid: p.xuid ?? null,
      gamertag: p.gamertag ?? null,
      modernGamertag: p.modernGamertag ?? null,
      modernGamertagSuffix: p.modernGamertagSuffix ?? null,
      uniqueModernGamertag: p.uniqueModernGamertag ?? null,
    })),
    errorText: isObj ? text(json.error) ?? text(json.message) ?? text(json.error_message) : null,
  };
}

const toInt = (v) => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
};

function profileFromPerson(p) {
  return {
    xuid: String(p.xuid),
    gamertag: p.gamertag || p.modernGamertag || null,
    uniqueGamertag: p.uniqueModernGamertag || null,
    gamerpic: p.displayPicRaw || null,
    gamerscore: toInt(p.gamerScore),
    reputation: p.xboxOneRep || null,
    accountTier: p.detail?.accountTier || null,
    tenureYears: toInt(p.detail?.tenure),
  };
}

/** 応答の中から指定した名前のキーを持つ値を探す(入れ子でも拾う)。 */
function findKey(json, key) {
  const seen = new Set();
  const queue = [json];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (!Array.isArray(node) && key in node) return node[key];
    queue.push(...Object.values(node));
  }
  return undefined;
}

function profileFromAccount(acc) {
  const users = findKey(acc, 'profileUsers');
  const user = Array.isArray(users) ? users[0] : null;
  if (!user) return {};
  const s = Object.fromEntries((user.settings ?? []).map((x) => [x.id, x.value]));
  const out = {};
  if (s.Gamertag) out.gamertag = s.Gamertag;
  if (s.GameDisplayPicRaw) out.gamerpic = s.GameDisplayPicRaw;
  if (toInt(s.Gamerscore) != null) out.gamerscore = toInt(s.Gamerscore);
  if (s.XboxOneRep) out.reputation = s.XboxOneRep;
  if (s.AccountTier) out.accountTier = s.AccountTier;
  return out;
}

const isRateLimit = (e) => e?.status === 429;

/** 診断用: どんな応答だったかの要約(値はほとんど含めない)。 */
export function summarizeShape(json) {
  const isObj = json && typeof json === 'object' && !Array.isArray(json);
  const titles = extractTitles(json);
  return {
    responseType: json === null ? 'null(JSONではない応答)' : Array.isArray(json) ? `array(${json.length})` : typeof json,
    topLevelKeys: isObj ? Object.keys(json).slice(0, 30) : null,
    titlesFound: titles.length,
    firstTitleKeys: titles[0] ? Object.keys(titles[0]).slice(0, 40) : null,
    minecraftLike: titles
      .filter((t) => /minecraft/i.test(String(t.name)))
      .slice(0, 8)
      .map((t) => ({ titleId: t.titleId, name: t.name, achievement: t.achievement ?? null })),
  };
}

/**
 * ゲーム履歴を読む。最初のエンドポイントで履歴が見つからなければ、予備のエンドポイントも試す。
 * @returns {{titles: Array|null, reason: string|null, source: string|null}}
 */
async function loadTitles(client, xuid, debugInfo) {
  const sources = [
    ['achievements/player', () => client.getTitles(xuid)],
    ['player/titleHistory', () => client.getTitleHistory(xuid)],
  ];
  let reason = 'empty';
  for (const [name, fetchIt] of sources) {
    try {
      const json = await fetchIt();
      const titles = extractTitles(json);
      if (debugInfo) debugInfo.titleSources.push({ source: name, ...summarizeShape(json) });
      if (titles.length > 0) return { titles, reason: null, source: name };
    } catch (e) {
      if (isRateLimit(e)) throw e;
      if (debugInfo) debugInfo.titleSources.push({ source: name, error: e?.status ?? String(e?.message ?? e) });
      // 非公開を示す応答が一度でもあれば、その理由を優先する
      if (e?.status === 401 || e?.status === 403) reason = 'private';
      else if (reason !== 'private') reason = 'error';
    }
  }
  return { titles: null, reason, source: null };
}

/**
 * @param {string} query  検証済みのゲーマータグ
 * @param {object} deps
 * @param {object} deps.client  createOpenXblClient の戻り値と同じ形
 */
export async function lookupGamertag(query, { client, config = SCORE_CONFIG, extraTitleIds = [], debug = false }) {
  const result = {
    query,
    found: false,
    searchedAs: [],
    candidates: [],
    ambiguous: [],
    profile: null,
    history: null,
    playtime: null,
    score: null,
    notes: [],
  };
  if (debug) result.debug = { searches: [], account: null, titleSources: [], titleAchievements: [] };

  // 1. 存在確認(ゲーマータグ検索)
  let match = null;
  let ambiguous = [];
  const seenPeople = [];
  for (const term of searchTermsFor(query)) {
    const json = await client.searchPlayers(term);
    result.searchedAs.push(term);
    if (debug) result.debug.searches.push({ term, ...summarizeSearch(json) });
    const people = extractPeople(json);
    seenPeople.push(...people);
    ({ match, ambiguous } = findExactMatch(people, query));
    if (match) break;
  }
  if (!match) {
    result.candidates = [...new Set(seenPeople.map(displayName))].slice(0, 5);
    return result;
  }
  result.found = true;
  result.ambiguous = ambiguous;
  if (ambiguous.length > 1) {
    result.notes.push({
      tone: 'caution',
      text: `同じ名前のアカウントが${ambiguous.length}件あります。#付きの番号まで入力すると特定できます。`,
    });
  }

  // 2. プロフィール(ゲーマースコア・評判)
  let profile = profileFromPerson(match);
  try {
    const acc = await client.getAccount(profile.xuid);
    if (debug) result.debug.account = summarizeShape(acc);
    profile = { ...profile, ...profileFromAccount(acc) };
  } catch (e) {
    if (isRateLimit(e)) throw e;
    if (debug) result.debug.account = { error: e?.status ?? String(e?.message ?? e) };
    result.notes.push({ tone: 'info', text: 'プロフィールの詳細を取得できなかったため、検索結果の情報で代用しています。' });
  }
  result.profile = profile;

  // 3. ゲーム履歴と実績
  const { titles, reason: historyReason, source: historySource } = await loadTitles(client, profile.xuid, result.debug);
  const historyVisible = Array.isArray(titles) && titles.length > 0;

  // 履歴に実績の数が付いていない Minecraft タイトルは、タイトルごとの実績一覧から数える
  if (historyVisible) {
    for (const t of titles) {
      if (!isBedrockTitle(t, extraTitleIds) || hasAchievementData(t)) continue;
      try {
        const json = await client.getTitleAchievements(profile.xuid, t.titleId);
        const fromTitle = extractTitles(json).find((x) => x.titleId === t.titleId && hasAchievementData(x));
        const counted = fromTitle?.achievement ?? countAchievements(json);
        if (debug) result.debug.titleAchievements.push({ titleId: t.titleId, ...summarizeShape(json), counted: counted ?? null });
        if (counted) t.achievement = { ...(t.achievement ?? {}), ...counted };
      } catch (e) {
        if (isRateLimit(e)) throw e;
        if (debug) result.debug.titleAchievements.push({ titleId: t.titleId, error: e?.status ?? String(e?.message ?? e) });
      }
    }
  }

  const mc = summarizeMinecraft(historyVisible ? titles : [], {
    defaultTotalAchievements: config.defaultTotalAchievements,
    extraIds: extraTitleIds,
  });
  result.history = {
    visible: historyVisible,
    reason: historyReason,
    source: historySource,
    titleCount: historyVisible ? titles.length : null,
    minecraft: mc,
  };
  if (historyVisible && mc.titles.length > 0 && mc.bestRate == null) {
    result.notes.push({
      tone: 'info',
      text: 'Minecraftの実績の数を取得できなかったため、残りの項目で配点を按分しています。',
    });
  }

  if (!historyVisible) {
    const text =
      historyReason === 'private'
        ? 'ゲーム履歴が非公開に設定されているため、実績とプレイ時間を確認できません。'
        : historyReason === 'error'
          ? 'ゲーム履歴の取得に失敗しました。時間をおいて再取得してください。'
          : 'ゲーム履歴が空です。非公開設定か、Xbox上でゲームを一度も記録していないアカウントです。';
    result.notes.push({ tone: 'caution', text });
  } else if (mc.titles.length === 0) {
    result.notes.push({
      tone: 'caution',
      text: 'ゲーム履歴にMinecraft(統合版)がありません。PlayStation版だけで遊んでいる場合、実績はPSN側に記録されるため低く出ます。',
    });
  }

  // 4. プレイ時間(取れれば加点、取れなければ按分)
  let playtime = { available: false, minutes: null, perTitle: null, reason: null };
  if (historyVisible && mc.titles.length > 0) {
    const ids = mc.titles.map((t) => t.titleId).filter(Boolean);
    const stats = ids.map((titleId) => ({ name: 'MinutesPlayed', titleId }));
    const attempts = [
      { xuids: [profile.xuid], groups: [], stats },
      // OpenXBL のドキュメント例と同じ形(groups 付き)で再試行
      { xuids: [profile.xuid], groups: [{ name: 'Hero', titleId: ids[0] }], stats },
    ];
    for (const body of attempts) {
      try {
        const found = extractMinutesPlayed(await client.getStats(body));
        if (found) {
          playtime = { available: true, minutes: found.minutes, perTitle: found.perTitle, reason: null };
        } else {
          playtime.reason = 'not_exposed';
        }
        break;
      } catch (e) {
        if (isRateLimit(e)) throw e;
        playtime.reason = 'error';
      }
    }
    if (!playtime.available) {
      result.notes.push({
        tone: 'info',
        text: 'プレイ時間は取得できませんでした。残りの項目で配点を按分しています。',
      });
    }
  } else if (historyVisible) {
    // 履歴は見えるが Minecraft がない → プレイ時間 0 とみなす
    playtime = { available: true, minutes: 0, perTitle: {}, reason: 'no_minecraft' };
  }
  result.playtime = playtime;

  // 5. スコア
  result.score = computeScore(
    {
      historyVisible,
      achievementRate: historyVisible ? mc.bestRate : null,
      playtimeHours: playtime.available ? playtime.minutes / 60 : null,
      gamerscore: profile.gamerscore ?? null,
      reputation: profile.reputation,
      minecraftFound: mc.titles.length > 0,
    },
    config,
  );

  if (profile.reputation && result.score.reputationFactor < 1) {
    result.notes.push({
      tone: 'danger',
      text: `Xboxの評判が「${profile.reputation}」です(スコアに×${result.score.reputationFactor}の補正)。`,
    });
  }

  return result;
}
