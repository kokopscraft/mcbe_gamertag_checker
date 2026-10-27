// ローカルの結合テスト用に OpenXBL の応答を真似るサーバー。
// 使い方: node scripts/mock-openxbl.mjs 8790
// .dev.vars に OPENXBL_BASE=http://127.0.0.1:8790/api/v2 と OPENXBL_API_KEY=test-key を入れて wrangler pages dev を起動します。

import http from 'node:http';

const PORT = Number(process.argv[2] ?? 8790);
const KEY = 'test-key';

const mc = (titleId, cur, gs, last, devices) => ({
  titleId,
  name: 'Minecraft',
  devices,
  achievement: { currentAchievements: cur, totalAchievements: 133, currentGamerscore: gs, totalGamerscore: 2980, progressPercentage: Math.round((cur / 133) * 100) },
  titleHistory: { lastTimePlayed: last, visible: true, canHide: false },
});

const players = {
  testplayer: {
    person: { xuid: '2535400000000001', gamertag: 'TestPlayer', modernGamertag: 'TestPlayer', uniqueModernGamertag: 'TestPlayer', gamerScore: '3500', xboxOneRep: 'GoodPlayer', displayPicRaw: '' },
    settings: [{ id: 'Gamertag', value: 'TestPlayer' }, { id: 'Gamerscore', value: '3500' }, { id: 'XboxOneRep', value: 'GoodPlayer' }, { id: 'AccountTier', value: 'Silver' }],
    titles: [
      mc('1828326430', 12, 260, '2026-03-02T10:00:00Z', ['XboxSeries']),
      mc('1739947436', 40, 905, '2026-10-25T12:30:00Z', ['Android']),
      { titleId: '1144039928', name: 'Halo: The Master Chief Collection', devices: ['XboxSeries'], achievement: { currentAchievements: 50, totalAchievements: 700, currentGamerscore: 600, totalGamerscore: 7000 }, titleHistory: { lastTimePlayed: '2025-12-01T00:00:00Z' } },
    ],
    minutes: { 1828326430: 900, 1739947436: 2700 },
  },
  privateplayer: {
    person: { xuid: '2535400000000002', gamertag: 'PrivatePlayer', gamerScore: '12000', xboxOneRep: 'GoodPlayer' },
    settings: [{ id: 'Gamerscore', value: '12000' }, { id: 'XboxOneRep', value: 'GoodPlayer' }],
    titlesStatus: 403,
  },
  psplayer: {
    person: { xuid: '2535400000000003', gamertag: 'PsPlayer', gamerScore: '0', xboxOneRep: 'GoodPlayer' },
    settings: [{ id: 'Gamerscore', value: '0' }, { id: 'XboxOneRep', value: 'GoodPlayer' }],
    titles: [{ titleId: '1', name: 'Xbox App', devices: ['PC'], achievement: { currentAchievements: 0, totalAchievements: 0, currentGamerscore: 0 }, titleHistory: { lastTimePlayed: '2026-09-01T00:00:00Z' } }],
  },
  badrep: {
    person: { xuid: '2535400000000004', gamertag: 'BadRep', gamerScore: '800', xboxOneRep: 'AvoidMe' },
    settings: [{ id: 'Gamerscore', value: '800' }, { id: 'XboxOneRep', value: 'AvoidMe' }],
    titles: [mc('896928775', 5, 60, '2026-10-26T00:00:00Z', ['PC'])],
    statsStatus: 500,
  },
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.headers['x-authorization'] !== KEY) return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/v2/, ''));
    let m;
    if ((m = /^\/search\/(.+)$/.exec(path))) {
      const q = m[1].toLowerCase();
      if (q === 'ratelimited') return send(res, 429, { error: 'Too Many Requests' });
      const exact = players[q];
      const people = exact ? [exact.person] : [{ xuid: '2535400000000099', gamertag: `${m[1]}2`, gamerScore: '10' }];
      return send(res, 200, { people, recommendationSummary: null });
    }
    const byXuid = (xuid) => Object.values(players).find((p) => p.person.xuid === xuid);
    if ((m = /^\/account\/(\d+)$/.exec(path))) {
      const p = byXuid(m[1]);
      return p ? send(res, 200, { profileUsers: [{ id: m[1], settings: p.settings }] }) : send(res, 404, {});
    }
    if ((m = /^\/achievements\/player\/(\d+)$/.exec(path))) {
      const p = byXuid(m[1]);
      if (!p) return send(res, 404, {});
      if (p.titlesStatus) return send(res, p.titlesStatus, { error: 'forbidden' });
      return send(res, 200, { xuid: m[1], titles: p.titles });
    }
    if (path === '/player/stats' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      const p = byXuid(body.xuids?.[0]);
      if (!p) return send(res, 404, {});
      if (p.statsStatus) return send(res, p.statsStatus, { error: 'boom' });
      const stats = (body.stats ?? [])
        .filter((s) => p.minutes?.[s.titleId] != null)
        .map((s) => ({ xuid: p.person.xuid, titleid: s.titleId, name: 'MinutesPlayed', type: 'Integer', value: String(p.minutes[s.titleId]) }));
      return send(res, 200, { groups: [], statlistscollection: [{ arrangebyfield: 'xuid', xuid: p.person.xuid, stats }] });
    }
    return send(res, 404, { error: 'not found', path });
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock OpenXBL on http://127.0.0.1:${PORT}/api/v2`));
