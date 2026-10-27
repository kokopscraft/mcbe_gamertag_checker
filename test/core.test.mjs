import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeScore, logRatio, reputationFactor } from '../lib/score.js';
import { isBedrockTitle, summarizeMinecraft, extractMinutesPlayed } from '../lib/minecraft.js';
import { lookupGamertag, validateGamertag, findExactMatch } from '../lib/lookup-core.js';
import { OpenXblError } from '../lib/openxbl.js';

const mcTitle = (id, name, cur, total, gs, last) => ({
  titleId: id,
  name,
  devices: ['PC'],
  achievement: { currentAchievements: cur, totalAchievements: total, currentGamerscore: gs, totalGamerscore: 2980 },
  titleHistory: { lastTimePlayed: last },
});

test('logRatio: 0 と上限と頭打ち', () => {
  assert.equal(logRatio(0, 100), 0);
  assert.equal(logRatio(100, 100), 1);
  assert.equal(logRatio(1e6, 100), 1);
  assert.equal(logRatio(null, 100), 0);
});

test('reputationFactor: 既知・部分一致・未知', () => {
  assert.equal(reputationFactor('GoodPlayer').factor, 1);
  assert.equal(reputationFactor('NeedsWork').factor, 0.7);
  assert.equal(reputationFactor('avoidme').factor, 0.4);
  assert.equal(reputationFactor('Something').factor, 1);
  assert.equal(reputationFactor(null).factor, 1);
});

test('computeScore: 前回の説明と同じ例で 59 と 14', () => {
  const a = computeScore({ historyVisible: true, achievementRate: 40 / 133, playtimeHours: 60, gamerscore: 3500, reputation: 'GoodPlayer' });
  assert.equal(a.score, 59);
  assert.equal(a.confidence, 'high');
  assert.equal(a.band.tone, 'caution');
  const b = computeScore({ historyVisible: true, achievementRate: 3 / 133, playtimeHours: 1, gamerscore: 50, reputation: 'GoodPlayer' });
  assert.equal(b.score, 14);
  assert.equal(b.band.tone, 'danger');
});

test('computeScore: プレイ時間なしは按分、非公開は判定不能', () => {
  const r = computeScore({ historyVisible: true, achievementRate: 1, playtimeHours: null, gamerscore: 10000, reputation: null });
  assert.equal(r.score, 100);
  assert.equal(r.confidence, 'medium');
  const sumW = r.parts.filter((p) => p.available).reduce((s, p) => s + p.effectiveWeight, 0);
  assert.ok(Math.abs(sumW - 1) < 1e-12);
  const u = computeScore({ historyVisible: false, achievementRate: null, playtimeHours: null, gamerscore: 5000, reputation: null });
  assert.equal(u.score, null);
  assert.equal(u.status, 'undetermined');
});

test('computeScore: 評判の補正', () => {
  const r = computeScore({ historyVisible: true, achievementRate: 1, playtimeHours: 100, gamerscore: 10000, reputation: 'AvoidMe' });
  assert.equal(r.score, 40);
});

test('isBedrockTitle: 除外タイトルと既知ID', () => {
  assert.ok(isBedrockTitle(mcTitle('1828326430', 'Minecraft', 1, 133, 10)));
  assert.ok(isBedrockTitle(mcTitle('999', 'Minecraft for Windows', 5, 133, 10)));
  assert.ok(!isBedrockTitle(mcTitle('998', 'Minecraft Dungeons', 5, 70, 10)));
  assert.ok(!isBedrockTitle(mcTitle('997', 'Minecraft Legends', 5, 70, 10)));
  assert.ok(!isBedrockTitle({ titleId: '996', name: 'Minecraft Launcher', achievement: { totalAchievements: 0, currentAchievements: 0 } }));
  assert.ok(isBedrockTitle(mcTitle('123', 'Something', 0, 0, 0), ['123']));
});

test('summarizeMinecraft: 機種別の最大達成率と最終プレイ', () => {
  const s = summarizeMinecraft([
    mcTitle('1828326430', 'Minecraft', 10, 133, 200, '2026-01-01T00:00:00Z'),
    mcTitle('1739947436', 'Minecraft', 40, 133, 900, '2026-10-01T00:00:00Z'),
    mcTitle('5', 'Halo', 10, 50, 100, '2026-10-20T00:00:00Z'),
  ]);
  assert.equal(s.titles.length, 2);
  assert.equal(s.bestTitleId, '1739947436');
  assert.ok(Math.abs(s.bestRate - 40 / 133) < 1e-12);
  assert.equal(s.minecraftGamerscore, 1100);
  assert.equal(s.lastPlayed, '2026-10-01T00:00:00Z');
});

test('extractMinutesPlayed: 形の違う応答から拾う', () => {
  const a = extractMinutesPlayed({
    statlistscollection: [{ xuid: '1', stats: [{ name: 'MinutesPlayed', titleid: '1828326430', value: '600' }, { name: 'MinutesPlayed', titleid: '1739947436', value: '120' }] }],
  });
  assert.equal(a.minutes, 720);
  const b = extractMinutesPlayed({ users: [{ scids: [{ scid: 'x', stats: [{ statname: 'MinutesPlayed', value: 30 }] }] }] });
  assert.equal(b.minutes, 30);
  assert.equal(extractMinutesPlayed({ stats: [] }), null);
});

test('validateGamertag', () => {
  assert.equal(validateGamertag('  Foo  Bar ').value, 'Foo Bar');
  assert.equal(validateGamertag('').ok, false);
  assert.equal(validateGamertag('a/b').ok, false);
  assert.equal(validateGamertag('x'.repeat(40)).ok, false);
  assert.equal(validateGamertag('くま#1234').ok, true);
});

test('findExactMatch: #付きと大文字小文字', () => {
  const people = [
    { xuid: '1', gamertag: 'Steve', modernGamertag: 'Steve', uniqueModernGamertag: 'Steve' },
    { xuid: '2', gamertag: 'Steve1234', modernGamertag: 'Steve', modernGamertagSuffix: '1234', uniqueModernGamertag: 'Steve#1234' },
  ];
  assert.equal(findExactMatch(people, 'steve').match.xuid, '1');
  assert.equal(findExactMatch(people, 'Steve#1234').match.xuid, '2');
  assert.equal(findExactMatch(people, 'Alex').match, null);
});

function fakeClient(overrides = {}) {
  const calls = [];
  const base = {
    searchPlayers: async () => ({ people: [{ xuid: '42', gamertag: 'TestPlayer', gamerScore: '3500', xboxOneRep: 'GoodPlayer' }] }),
    getAccount: async () => ({ profileUsers: [{ id: '42', settings: [{ id: 'Gamerscore', value: '3500' }, { id: 'XboxOneRep', value: 'GoodPlayer' }] }] }),
    getTitles: async () => ({ titles: [mcTitle('1828326430', 'Minecraft', 40, 133, 900, '2026-10-01T00:00:00Z')] }),
    getStats: async () => ({ statlistscollection: [{ stats: [{ name: 'MinutesPlayed', titleid: '1828326430', value: '3600' }] }] }),
    ...overrides,
  };
  const wrapped = {};
  for (const [k, fn] of Object.entries(base)) {
    wrapped[k] = async (...args) => {
      calls.push(k);
      return fn(...args);
    };
  }
  wrapped.calls = calls;
  return wrapped;
}

test('lookupGamertag: 通常の照会', async () => {
  const client = fakeClient();
  const r = await lookupGamertag('TestPlayer', { client });
  assert.equal(r.found, true);
  assert.equal(r.playtime.minutes, 3600);
  assert.equal(r.score.score, 59);
  assert.deepEqual(client.calls, ['searchPlayers', 'getAccount', 'getTitles', 'getStats']);
});

test('lookupGamertag: 見つからない', async () => {
  const client = fakeClient({ searchPlayers: async () => ({ people: [{ xuid: '9', gamertag: 'TestPlayer2' }] }) });
  const r = await lookupGamertag('TestPlayer', { client });
  assert.equal(r.found, false);
  assert.deepEqual(r.candidates, ['TestPlayer2']);
  assert.deepEqual(client.calls, ['searchPlayers']);
});

test('lookupGamertag: 履歴が非公開なら判定不能', async () => {
  const client = fakeClient({
    getTitles: async () => {
      throw new OpenXblError(403, 'forbidden');
    },
  });
  const r = await lookupGamertag('TestPlayer', { client });
  assert.equal(r.score.status, 'undetermined');
  assert.equal(r.history.reason, 'private');
  assert.ok(!client.calls.includes('getStats'));
});

test('lookupGamertag: プレイ時間APIが失敗したら groups 付きで再試行し、だめなら按分', async () => {
  let n = 0;
  const client = fakeClient({
    getStats: async () => {
      n += 1;
      throw new OpenXblError(400, 'bad');
    },
  });
  const r = await lookupGamertag('TestPlayer', { client });
  assert.equal(n, 2);
  assert.equal(r.playtime.available, false);
  assert.equal(r.score.confidence, 'medium');
});

test('lookupGamertag: 上限到達は呼び出し元へ伝える', async () => {
  const client = fakeClient({
    getTitles: async () => {
      throw new OpenXblError(429, 'too many');
    },
  });
  await assert.rejects(() => lookupGamertag('TestPlayer', { client }), (e) => e.status === 429);
});

test('lookupGamertag: 履歴はあるが Minecraft なし', async () => {
  const client = fakeClient({ getTitles: async () => ({ titles: [mcTitle('5', 'Halo', 10, 50, 100, '2026-10-20T00:00:00Z')] }) });
  const r = await lookupGamertag('TestPlayer', { client });
  assert.equal(r.history.minecraft.titles.length, 0);
  assert.equal(r.playtime.minutes, 0);
  assert.equal(r.score.confidence, 'low');
  assert.ok(!client.calls.includes('getStats'));
  assert.ok(r.notes.some((n) => n.text.includes('PlayStation')));
});
