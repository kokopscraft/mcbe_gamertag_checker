// ゲーマータグ 1 件を照会する一連の処理(API の呼び出し順・判定・スコア計算)。
// HTTP やキャッシュには依存しないので、テストでは偽のクライアントを渡せます。

import { computeScore, SCORE_CONFIG } from './score.js';
import { summarizeMinecraft, extractMinutesPlayed } from './minecraft.js';

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
  if (p.modernGamertag && p.modernGamertagSuffix) names.push(`${p.modernGamertag}#${p.modernGamertagSuffix}`);
  return names.filter(Boolean).map(norm);
}

/** 検索結果の中から、入力と完全一致するアカウントを選ぶ。 */
export function findExactMatch(people, query) {
  const q = norm(query);
  const exact = people.filter((p) => p?.xuid && namesOf(p).includes(q));
  if (exact.length === 0) return { match: null, ambiguous: [] };
  // 旧式ゲーマータグの完全一致を優先
  const classic = exact.find((p) => norm(p.gamertag) === q);
  const match = classic ?? exact[0];
  return { match, ambiguous: exact.length > 1 ? exact.map(displayName) : [] };
}

function displayName(p) {
  return p.uniqueModernGamertag || p.gamertag || p.modernGamertag || p.displayName || String(p.xuid);
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

function profileFromAccount(acc) {
  const user = acc?.profileUsers?.[0];
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

/**
 * @param {string} query  検証済みのゲーマータグ
 * @param {object} deps
 * @param {object} deps.client  createOpenXblClient の戻り値と同じ形
 */
export async function lookupGamertag(query, { client, config = SCORE_CONFIG, extraTitleIds = [] }) {
  const result = {
    query,
    found: false,
    candidates: [],
    ambiguous: [],
    profile: null,
    history: null,
    playtime: null,
    score: null,
    notes: [],
  };

  // 1. 存在確認(ゲーマータグ検索)
  const search = await client.searchPlayers(query);
  const people = Array.isArray(search?.people) ? search.people : [];
  const { match, ambiguous } = findExactMatch(people, query);
  if (!match) {
    result.candidates = people.slice(0, 5).map(displayName);
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
    profile = { ...profile, ...profileFromAccount(await client.getAccount(profile.xuid)) };
  } catch (e) {
    if (isRateLimit(e)) throw e;
    result.notes.push({ tone: 'info', text: 'プロフィールの詳細を取得できなかったため、検索結果の情報で代用しています。' });
  }
  result.profile = profile;

  // 3. ゲーム履歴と実績
  let titles = null;
  let historyReason = null;
  try {
    const t = await client.getTitles(profile.xuid);
    titles = Array.isArray(t?.titles) ? t.titles : [];
    if (titles.length === 0) historyReason = 'empty';
  } catch (e) {
    if (isRateLimit(e)) throw e;
    historyReason = e?.status === 401 || e?.status === 403 ? 'private' : 'error';
  }
  const historyVisible = Array.isArray(titles) && titles.length > 0;
  const mc = summarizeMinecraft(historyVisible ? titles : [], {
    defaultTotalAchievements: config.defaultTotalAchievements,
    extraIds: extraTitleIds,
  });
  result.history = {
    visible: historyVisible,
    reason: historyReason,
    titleCount: historyVisible ? titles.length : null,
    minecraft: mc,
  };

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
