import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeScore, logRatio, reputationFactor } from '../lib/score.js';
import { isBedrockTitle, summarizeMinecraft, extractMinutesPlayed } from '../lib/minecraft.js';
import {
  lookupGamertag,
  validateGamertag,
  findExactMatch,
  searchTermsFor,
  extractPeople,
  summarizeSearch,
} from '../lib/lookup-core.js';
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
  assert.ok(Math.abs(s.bestRate - 900 / 2980) < 1e-12);
  assert.equal(s.titles[0].rateBasis, 'gamerscore');
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
    getTitleHistory: async () => ({ titles: [] }),
    getTitleAchievements: async () => ({ achievements: [] }),
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
  assert.equal(r.score.score, 60); // 達成率 900/2980 で 59.54 → 60(Pythonで検算)
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
    getTitleHistory: async () => {
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

// ---- #付き(新形式)ゲーマータグへの対応 ----

const modernPeople = [
  { xuid: '101', gamertag: 'sirokuru', modernGamertag: 'sirokuru', modernGamertagSuffix: '', uniqueModernGamertag: 'sirokuru' },
  { xuid: '202', gamertag: 'sirokuru4202', modernGamertag: 'sirokuru', modernGamertagSuffix: '4202', uniqueModernGamertag: 'sirokuru#4202' },
  { xuid: '303', gamertag: 'sirokuru1111', modernGamertag: 'sirokuru', modernGamertagSuffix: '1111', uniqueModernGamertag: 'sirokuru#1111' },
];

test('searchTermsFor: #付きは名前だけ、末尾数字は名前でも再検索', () => {
  assert.deepEqual(searchTermsFor('sirokuru#4202'), ['sirokuru']);
  assert.deepEqual(searchTermsFor('sirokuru4202'), ['sirokuru4202', 'sirokuru']);
  assert.deepEqual(searchTermsFor('Steve'), ['Steve']);
  assert.deepEqual(searchTermsFor('12345'), ['12345']);
});

test('findExactMatch: 新形式の名前を番号で特定する', () => {
  assert.equal(findExactMatch(modernPeople, 'sirokuru#4202').match.xuid, '202');
  assert.equal(findExactMatch(modernPeople, 'SIROKURU#4202').match.xuid, '202');
  assert.equal(findExactMatch(modernPeople, 'sirokuru4202').match.xuid, '202');
  // 番号なしは、番号を持たない本人を優先(同名が複数ある旨も返す)
  const r = findExactMatch(modernPeople, 'sirokuru');
  assert.equal(r.match.xuid, '101');
  assert.equal(r.ambiguous.length, 3);
  assert.equal(findExactMatch(modernPeople, 'sirokuru#9999').match, null);
});

test('extractPeople: 入れ子の形や id でも拾う', () => {
  assert.equal(extractPeople({ people: modernPeople }).length, 3);
  assert.equal(extractPeople({ content: { people: modernPeople } }).length, 3);
  assert.equal(extractPeople({ data: [{ id: '9', gamertag: 'X' }] })[0].xuid, '9');
  assert.deepEqual(extractPeople(null), []);
  assert.deepEqual(extractPeople({ error: 'nope' }), []);
});

test('summarizeSearch: 形の要約', () => {
  const s = summarizeSearch({ content: { people: modernPeople }, code: 200 });
  assert.deepEqual(s.topLevelKeys, ['content', 'code']);
  assert.equal(s.peopleCount, 3);
  assert.equal(s.samples[1].uniqueModernGamertag, 'sirokuru#4202');
  assert.equal(summarizeSearch(null).peopleCount, 0);
  assert.equal(summarizeSearch({ error: 'Invalid key' }).errorText, 'Invalid key');
});

test('lookupGamertag: 「名前#番号」は名前で検索して見つける', async () => {
  const terms = [];
  const client = fakeClient({
    searchPlayers: async (t) => {
      terms.push(t);
      return t === 'sirokuru' ? { people: modernPeople } : { people: [] };
    },
  });
  const r = await lookupGamertag('sirokuru#4202', { client, debug: true });
  assert.equal(r.found, true);
  assert.equal(r.profile.xuid, '202');
  assert.deepEqual(terms, ['sirokuru']);
  assert.equal(r.debug.searches[0].peopleCount, 3);
});

test('lookupGamertag: 「名前番号」で見つからなければ名前で再検索', async () => {
  const terms = [];
  const client = fakeClient({
    searchPlayers: async (t) => {
      terms.push(t);
      return t === 'sirokuru' ? { content: { people: modernPeople } } : { people: [] };
    },
  });
  const r = await lookupGamertag('sirokuru4202', { client });
  assert.equal(r.found, true);
  assert.equal(r.profile.xuid, '202');
  assert.deepEqual(terms, ['sirokuru4202', 'sirokuru']);
  assert.deepEqual(r.searchedAs, ['sirokuru4202', 'sirokuru']);
});

// ---- 応答の形の違いへの対応 ----

import { unwrapEnvelope, createOpenXblClient } from '../lib/openxbl.js';
import { extractTitles, countAchievements } from '../lib/minecraft.js';

test('unwrapEnvelope: content を外す・文字列の JSON も読む・code>=400 はエラー', () => {
  assert.deepEqual(unwrapEnvelope({ content: { a: 1 }, code: 200 }), { a: 1 });
  assert.deepEqual(unwrapEnvelope({ content: '{"b":2}', code: 200 }), { b: 2 });
  assert.deepEqual(unwrapEnvelope({ people: [], content: 'x' }), { people: [], content: 'x' }); // 包み紙ではない
  assert.throws(() => unwrapEnvelope({ content: {}, code: 403 }), (e) => e.status === 403);
});

test('extractTitles: 入れ子の titles と、360形式の実績一覧の取り違え防止', () => {
  const nested = { xuid: '1', data: { titles: [{ titleId: 2047319603, name: 'Minecraft for Nintendo Switch' }] } };
  assert.equal(extractTitles(nested)[0].titleId, '2047319603');
  assert.deepEqual(extractTitles({ achievements: [{ titleId: 1, unlocked: true }] }), []);
});

test('countAchievements: Xbox One 形式を数える', () => {
  const json = {
    achievements: [
      { id: '1', progressState: 'Achieved', rewards: [{ type: 'Gamerscore', value: '20' }] },
      { id: '2', progressState: 'NotStarted', rewards: [{ type: 'Gamerscore', value: '30' }] },
      { id: '3', progressState: 'Achieved', rewards: [{ type: 'Gamerscore', value: '15' }] },
    ],
    pagingInfo: { continuationToken: 'x', totalRecords: 133 },
  };
  assert.deepEqual(countAchievements(json), { currentAchievements: 2, totalAchievements: 133, currentGamerscore: 35 });
  assert.equal(countAchievements({ foo: [] }), null);
});

test('lookupGamertag: 最初の履歴が空なら予備の履歴を読み、実績はタイトルごとに数える', async () => {
  const client = fakeClient({
    // 実績一覧(タイトル単位ではない)が返る想定
    getTitles: async () => ({ achievements: [{ id: '1', progressState: 'Achieved', titleAssociations: [{ id: 1 }] }] }),
    // 実績の数が付いていない履歴
    getTitleHistory: async () => ({ content: { titles: [{ titleId: '2047319603', name: 'Minecraft for Nintendo Switch', titleHistory: { lastTimePlayed: '2026-10-01T00:00:00Z' } }] } }),
    getTitleAchievements: async () => ({
      achievements: Array.from({ length: 133 }, (_, i) => ({ id: String(i), progressState: i < 67 ? 'Achieved' : 'NotStarted' })),
    }),
  });
  const r = await lookupGamertag('TestPlayer', { client, debug: true });
  assert.equal(r.history.visible, true);
  assert.equal(r.history.source, 'player/titleHistory');
  assert.equal(r.history.minecraft.titles[0].currentAchievements, 67);
  assert.ok(Math.abs(r.history.minecraft.bestRate - 67 / 133) < 1e-12);
  assert.equal(r.score.status, 'scored');
  assert.deepEqual(client.calls, ['searchPlayers', 'getAccount', 'getTitles', 'getTitleHistory', 'getTitleAchievements', 'getStats']);
  assert.equal(r.debug.titleSources.length, 2);
});

test('createOpenXblClient: captureRaw で受け取った応答をそのまま記録する', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ content: { people: [{ xuid: '1' }] }, code: 200 }), { status: 200 });
  const c = createOpenXblClient({ apiKey: 'k', fetchImpl, captureRaw: true });
  const data = await c.searchPlayers('a#1');
  assert.deepEqual(data, { people: [{ xuid: '1' }] }); // 呼び出し側には包み紙を外した値
  assert.equal(c.rawLog.length, 1);
  assert.equal(c.rawLog[0].path, '/search/a%231');
  assert.deepEqual(c.rawLog[0].body, { content: { people: [{ xuid: '1' }] }, code: 200 }); // 記録は加工なし
  const c2 = createOpenXblClient({ apiKey: 'k', fetchImpl });
  await c2.searchPlayers('a');
  assert.equal(c2.rawLog.length, 0);
});

test('実データの形: Launcher と Preview は数えず、Windows と Switch だけ集計する', () => {
  const ach = (cur, gs) => ({ currentAchievements: cur, totalAchievements: 0, currentGamerscore: gs, totalGamerscore: gs ? 2980 : 0 });
  const titles = [
    { titleId: '896928775', name: 'Minecraft for Windows', devices: ['PC'], achievement: ach(15, 225) },
    { titleId: '1904044383', name: 'Minecraft Preview for Windows', devices: ['PC'], achievement: ach(0, 0) },
    { titleId: '1794566092', name: 'Minecraft Launcher', devices: ['PC'], achievement: ach(0, 0) },
    { titleId: '2047319603', name: 'Minecraft for Nintendo Switch', devices: ['Nintendo Switch'], achievement: ach(67, 1470) },
  ];
  const s = summarizeMinecraft(titles);
  assert.deepEqual(s.titles.map((t) => t.titleId), ['2047319603', '896928775']);
  assert.deepEqual(s.titles.map((t) => t.platform), ['Nintendo Switch', 'Windows']);
  assert.ok(Math.abs(s.bestRate - 1470 / 2980) < 1e-12);
  assert.equal(s.minecraftGamerscore, 1695);
});

// ---- 達成率の根拠と本名の伏せ字 ----

import { achievementRateOf } from '../lib/minecraft.js';
import { maskRealNames, maskRealNamesInText, MASK } from '../lib/openxbl.js';

test('achievementRateOf: 満点GSがあればGSの割合、なければ解除数', () => {
  assert.deepEqual(achievementRateOf({ currentGamerscore: 1470, totalGamerscore: 2980, currentAchievements: 67, totalAchievements: 0 }), { rate: 1470 / 2980, basis: 'gamerscore' });
  assert.deepEqual(achievementRateOf({ currentGamerscore: 0, totalGamerscore: 0, currentAchievements: 67, totalAchievements: 0 }), { rate: 67 / 133, basis: 'count' });
  assert.deepEqual(achievementRateOf({ currentAchievements: 10, totalAchievements: 20 }), { rate: 0.5, basis: 'count' });
});

test('countAchievements: 一覧が揃っていれば満点GSも数え、GSの割合が使われる', () => {
  const list = { achievements: [
    { progressState: 'Achieved', rewards: [{ type: 'Gamerscore', value: '30' }] },
    { progressState: 'NotStarted', rewards: [{ type: 'Gamerscore', value: '70' }] },
  ] };
  const c = countAchievements(list);
  assert.equal(c.totalGamerscore, 100);
  assert.equal(achievementRateOf(c).rate, 0.3);
  // 分割されていて揃っていなければ満点GSは付けない
  assert.equal(countAchievements({ ...list, pagingInfo: { totalRecords: 133 } }).totalGamerscore, undefined);
});

test('maskRealNames: 実際の応答の形で本名だけを伏せる(元データは変えない)', () => {
  const raw = {
    content: {
      people: [{ xuid: '1', displayName: null, realName: '山田 太郎', gamertag: 'yamada1234', uniqueModernGamertag: 'yamada#1234' }],
      profileUsers: [{ id: '1', settings: [
        { id: 'Gamertag', value: 'yamada1234' },
        { id: 'RealName', value: '' },
        { id: 'RealNameOverride', value: '山田 太郎' },
        { id: 'Location', value: 'Tokyo / Japan' },
      ] }],
    },
    code: 200,
  };
  const m = maskRealNames(raw);
  assert.equal(m.content.people[0].realName, MASK);
  assert.equal(m.content.people[0].gamertag, 'yamada1234');
  assert.equal(m.content.people[0].displayName, null);
  const settings = Object.fromEntries(m.content.profileUsers[0].settings.map((x) => [x.id, x.value]));
  assert.equal(settings.RealNameOverride, MASK);
  assert.equal(settings.RealName, ''); // 空欄はそのまま
  assert.equal(settings.Gamertag, 'yamada1234');
  assert.equal(settings.Location, 'Tokyo / Japan');
  assert.equal(raw.content.people[0].realName, '山田 太郎'); // 元データは不変
  assert.ok(!JSON.stringify(m).includes('山田'));
});

test('maskRealNames: ゲーマータグと異なる displayName は伏せ、同じなら残す', () => {
  assert.equal(maskRealNames({ gamertag: 'Steve', displayName: '佐藤 花子' }).displayName, MASK);
  assert.equal(maskRealNames({ gamertag: 'Steve', displayName: 'steve' }).displayName, 'steve');
});

test('maskRealNamesInText: 途中で切れた文字列でも伏せる', () => {
  const t = '{"people":[{"realName":"山田 太郎","gamertag":"x"}],"settings":[{"id":"RealNameOverride","value":"山田 太郎"},{"id":"Bio","value":"hi"}';
  const m = maskRealNamesInText(t);
  assert.ok(!m.includes('山田'));
  assert.ok(m.includes('"value":"hi"'));
});

test('createOpenXblClient: rawLog の本名は伏せ字、呼び出し側には本来の値', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ content: { people: [{ xuid: '1', gamertag: 'a', realName: '山田 太郎' }] }, code: 200 }), { status: 200 });
  const c = createOpenXblClient({ apiKey: 'k', fetchImpl, captureRaw: true });
  const data = await c.searchPlayers('a');
  assert.equal(data.people[0].realName, '山田 太郎');
  assert.equal(c.rawLog[0].body.content.people[0].realName, MASK);
});
