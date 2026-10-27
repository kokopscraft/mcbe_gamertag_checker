// 安全度スコアの計算。
// 重みやしきい値はこのファイルの SCORE_CONFIG だけを変えれば調整できます。

export const SCORE_CONFIG = Object.freeze({
  // 3項目の配点(合計 1.0)。取得できなかった項目は、残りの項目で按分します。
  weights: Object.freeze({
    achievements: 0.5, // Minecraft 実績達成率(最も進んでいる機種)
    playtime: 0.3, // Minecraft プレイ時間(取得できた機種の合計)
    gamerscore: 0.2, // アカウント全体のゲーマースコア
  }),
  // この値で満点になる(対数スケール)
  playtimeFullHours: 100,
  gamerscoreFull: 10000,
  // 実績総数が API から取れなかったときに使う値(2026年6月時点で 133 個)
  defaultTotalAchievements: 133,
  // Xbox の評判(XboxOneRep)による補正倍率
  reputationFactors: Object.freeze({
    GoodPlayer: 1.0,
    NeedsWork: 0.7,
    AvoidMe: 0.4,
  }),
  // 判定の区切り(上から順に評価)
  bands: Object.freeze([
    Object.freeze({ min: 70, label: '高い', tone: 'safe' }),
    Object.freeze({ min: 40, label: '中程度', tone: 'caution' }),
    Object.freeze({ min: 0, label: '低い', tone: 'danger' }),
  ]),
});

/** 0 → 0、full → 1 になる対数スケール(1 で頭打ち)。 */
export function logRatio(value, full) {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(full));
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** 評判の文字列から補正倍率を返す。未知の値は補正なし(1.0)。 */
export function reputationFactor(rep, cfg = SCORE_CONFIG) {
  if (!rep) return { factor: 1, known: false, value: null };
  if (Object.prototype.hasOwnProperty.call(cfg.reputationFactors, rep)) {
    return { factor: cfg.reputationFactors[rep], known: true, value: rep };
  }
  const r = String(rep).toLowerCase();
  if (r.includes('avoid')) return { factor: cfg.reputationFactors.AvoidMe, known: true, value: rep };
  if (r.includes('need')) return { factor: cfg.reputationFactors.NeedsWork, known: true, value: rep };
  if (r.includes('good')) return { factor: cfg.reputationFactors.GoodPlayer, known: true, value: rep };
  return { factor: 1, known: false, value: rep };
}

/**
 * @param {object} input
 * @param {boolean} input.historyVisible  ゲーム履歴を読めたか
 * @param {number|null} input.achievementRate  0〜1。読めなければ null
 * @param {number|null} input.playtimeHours  読めなければ null
 * @param {number|null} input.gamerscore  読めなければ null
 * @param {string|null} input.reputation  XboxOneRep の値
 * @param {boolean} [input.minecraftFound=true]  履歴に Minecraft があったか(なければ信頼度を「低」にする)
 */
export function computeScore(input, cfg = SCORE_CONFIG) {
  const { historyVisible, achievementRate, playtimeHours, gamerscore, reputation, minecraftFound = true } = input;

  const parts = [
    {
      key: 'achievements',
      label: 'Minecraftの実績達成率',
      weight: cfg.weights.achievements,
      available: achievementRate != null,
      ratio: achievementRate != null ? clamp01(achievementRate) : null,
    },
    {
      key: 'playtime',
      label: 'Minecraftのプレイ時間',
      weight: cfg.weights.playtime,
      available: playtimeHours != null,
      ratio: playtimeHours != null ? logRatio(playtimeHours, cfg.playtimeFullHours) : null,
    },
    {
      key: 'gamerscore',
      label: 'アカウント全体のゲーマースコア',
      weight: cfg.weights.gamerscore,
      available: gamerscore != null,
      ratio: gamerscore != null ? logRatio(gamerscore, cfg.gamerscoreFull) : null,
    },
  ];

  const rep = reputationFactor(reputation, cfg);

  if (!historyVisible) {
    return {
      status: 'undetermined',
      score: null,
      band: null,
      confidence: 'none',
      reputationFactor: rep.factor,
      parts: parts.map((p) => ({ ...p, effectiveWeight: null, contribution: null })),
    };
  }

  const available = parts.filter((p) => p.available);
  const totalWeight = available.reduce((s, p) => s + p.weight, 0);
  const withContribution = parts.map((p) => {
    if (!p.available || totalWeight === 0) return { ...p, effectiveWeight: null, contribution: null };
    const effectiveWeight = p.weight / totalWeight;
    return { ...p, effectiveWeight, contribution: 100 * effectiveWeight * p.ratio };
  });

  const base = withContribution.reduce((s, p) => s + (p.contribution ?? 0), 0); // 0〜100
  const score = Math.round(base * rep.factor);
  const band = cfg.bands.find((b) => score >= b.min) ?? cfg.bands[cfg.bands.length - 1];

  let confidence = 'low';
  if (available.length === parts.length) confidence = 'high';
  else if (parts[0].available && available.length >= 2) confidence = 'medium';
  // Minecraft の記録がない場合、実績 0・プレイ時間 0 は推定なので信頼度は低い
  if (!minecraftFound) confidence = 'low';

  return {
    status: 'scored',
    score,
    baseScore: base,
    band: { label: band.label, tone: band.tone },
    confidence,
    reputationFactor: rep.factor,
    parts: withContribution,
  };
}
