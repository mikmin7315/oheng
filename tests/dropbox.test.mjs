// 드롭박스 API는 네트워크 호출이므로 전역 fetch를 목으로 대체해 검증한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let calls = [];
const originalFetch = globalThis.fetch;

function installFetchMock(responses) {
  calls = [];
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const r = responses[i++];
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
  };
}

before(() => {
  process.env.DROPBOX_APP_KEY = 'test-key';
  process.env.DROPBOX_APP_SECRET = 'test-secret';
  process.env.DROPBOX_REFRESH_TOKEN = 'test-refresh';
});
after(() => { globalThis.fetch = originalFetch; });

const dropbox = await import('../api/_lib/dropbox.js');

test('이미지가 아닌 MIME 타입은 업로드 없이 즉시 거부된다', async () => {
  installFetchMock([]);
  await assert.rejects(
    () => dropbox.uploadReviewImage('AAAA', 'a.txt', 'text/plain'),
    (err) => { assert.equal(err.code, 'INVALID_TYPE'); return true; }
  );
  assert.equal(calls.length, 0, '검증 실패 시 네트워크 호출이 발생하면 안 됨');
});

test('5MB 초과 이미지는 업로드 없이 즉시 거부된다', async () => {
  installFetchMock([]);
  const big = Buffer.alloc(6 * 1024 * 1024, 1).toString('base64');
  await assert.rejects(
    () => dropbox.uploadReviewImage(big, 'big.png', 'image/png'),
    (err) => { assert.equal(err.code, 'TOO_LARGE'); return true; }
  );
  assert.equal(calls.length, 0);
});

test('정상 업로드: 토큰 발급 → 파일 업로드 → 공유링크 생성 → raw URL 변환', async () => {
  installFetchMock([
    { body: { access_token: 'tok123' } }, // oauth2/token
    { body: { path_display: '/review-images/1-a.png' } }, // files/upload
    { body: { url: 'https://www.dropbox.com/s/xyz/a.png?dl=0' } }, // create_shared_link_with_settings
  ]);
  const small = Buffer.from('hello').toString('base64');
  const url = await dropbox.uploadReviewImage(small, 'a.png', 'image/png');
  assert.equal(url, 'https://www.dropbox.com/s/xyz/a.png?raw=1');
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /oauth2\/token/);
  assert.match(calls[1].url, /files\/upload/);
  assert.match(calls[2].url, /create_shared_link_with_settings/);
});

test('이미 공유링크가 있는 파일은 create가 실패해도 list_shared_links로 기존 링크를 찾는다', async () => {
  installFetchMock([
    { body: { access_token: 'tok123' } },
    { body: { path_display: '/review-images/1-a.png' } },
    { ok: false, status: 409, body: { error_summary: 'shared_link_already_exists' } },
    { body: { links: [{ url: 'https://www.dropbox.com/s/existing/a.png?dl=0' }] } },
  ]);
  const small = Buffer.from('hello').toString('base64');
  const url = await dropbox.uploadReviewImage(small, 'a.png', 'image/png');
  assert.equal(url, 'https://www.dropbox.com/s/existing/a.png?raw=1');
  assert.equal(calls.length, 4);
  assert.match(calls[3].url, /list_shared_links/);
});
