import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from '../functions/_middleware.js';

const next = async () => new Response('ok', { status: 200 });
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;
const req = (auth) => new Request('https://example.test/', { headers: auth ? { Authorization: auth } : {} });

test('ADMIN_PASSWORD 未設定なら 503 で止める', async () => {
  const res = await onRequest({ request: req(), env: {}, next });
  assert.equal(res.status, 503);
});

test('認証なし・誤りは 401、正しければ通す(UTF-8 パスワード)', async () => {
  const env = { ADMIN_PASSWORD: 'pa55wörd' };
  assert.equal((await onRequest({ request: req(), env, next })).status, 401);
  assert.equal((await onRequest({ request: req(basic('admin', 'nope')), env, next })).status, 401);
  assert.equal((await onRequest({ request: req(basic('root', 'pa55wörd')), env, next })).status, 401);
  const ok = await onRequest({ request: req(basic('admin', 'pa55wörd')), env, next });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('ADMIN_USER を変えられる', async () => {
  const env = { ADMIN_PASSWORD: 'x', ADMIN_USER: 'koko' };
  assert.equal((await onRequest({ request: req(basic('koko', 'x')), env, next })).status, 200);
  assert.equal((await onRequest({ request: req(basic('admin', 'x')), env, next })).status, 401);
});

test('DISABLE_BASIC_AUTH=true のときだけ素通し', async () => {
  assert.equal((await onRequest({ request: req(), env: { DISABLE_BASIC_AUTH: 'true' }, next })).status, 200);
  assert.equal((await onRequest({ request: req(), env: { DISABLE_BASIC_AUTH: '1', ADMIN_PASSWORD: 'x' }, next })).status, 401);
});
