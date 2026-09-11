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

test('3MB 초과 이미지는 업로드 없이 즉시 거부된다', async () => {
  installFetchMock([]);
  const big = Buffer.alloc(4 * 1024 * 1024, 1).toString('base64');
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

test('listVideoFolder: /videos 폴더를 끝까지(has_more) 읽어 파일만 이름순으로 돌려준다', async () => {
  installFetchMock([
    { body: { access_token: 'tok' } },
    { body: { entries: [
      { '.tag': 'file', name: 'b강의.mp4', path_display: '/videos/b강의.mp4', size: 2048 },
      { '.tag': 'folder', name: '예전', path_display: '/videos/예전' },
    ], has_more: true, cursor: 'c1' } },
    { body: { entries: [
      { '.tag': 'file', name: 'a강의.mp4', path_display: '/videos/a강의.mp4', size: 1024 },
    ], has_more: false } },
  ]);
  const result = await dropbox.listVideoFolder();
  assert.equal(result.folderMissing, false);
  assert.deepEqual(result.files.map(f => f.name), ['a강의.mp4', 'b강의.mp4']);
  assert.deepEqual(result.files[0], { path: '/videos/a강의.mp4', name: 'a강의.mp4', size: 1024 });
  assert.match(calls[1].url, /\/files\/list_folder$/);
  assert.deepEqual(JSON.parse(calls[1].opts.body), { path: '/videos', recursive: false });
  assert.match(calls[2].url, /\/files\/list_folder\/continue$/);
  assert.deepEqual(JSON.parse(calls[2].opts.body), { cursor: 'c1' });
});

test('listVideoFolder: videos 폴더가 없으면 folderMissing으로 알려준다', async () => {
  installFetchMock([
    { body: { access_token: 'tok' } },
    { ok: false, status: 409, body: { error_summary: 'path/not_found/..' } },
  ]);
  const result = await dropbox.listVideoFolder();
  assert.deepEqual(result, { files: [], folderMissing: true });
});

test('getTemporaryLink: files/get_temporary_link로 받은 임시 주소를 그대로 돌려준다', async () => {
  installFetchMock([
    { body: { access_token: 'tok' } },
    { body: { link: 'https://dl.dropboxusercontent.com/apitl/1/abc' } },
  ]);
  const link = await dropbox.getTemporaryLink('/videos/a강의.mp4');
  assert.equal(link, 'https://dl.dropboxusercontent.com/apitl/1/abc');
  assert.match(calls[1].url, /\/files\/get_temporary_link$/);
  assert.deepEqual(JSON.parse(calls[1].opts.body), { path: '/videos/a강의.mp4' });
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer tok');
});

test('getTemporaryLink: 드롭박스가 거부하면 에러를 던진다', async () => {
  installFetchMock([
    { body: { access_token: 'tok' } },
    { ok: false, status: 409, body: { error_summary: 'path/not_found/' } },
  ]);
  await assert.rejects(
    () => dropbox.getTemporaryLink('/videos/없음.mp4'),
    (err) => { assert.equal(err.detail, 'path/not_found/'); return true; }
  );
});

test('드롭박스 열쇠가 없으면 NOT_CONFIGURED 코드로 실패하고 네트워크를 타지 않는다', async () => {
  installFetchMock([]);
  const saved = process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_KEY;
  try {
    await assert.rejects(
      () => dropbox.listVideoFolder(),
      (err) => { assert.equal(err.code, 'NOT_CONFIGURED'); return true; }
    );
    assert.equal(calls.length, 0);
  } finally {
    process.env.DROPBOX_APP_KEY = saved;
  }
});

// 반드시 이 파일의 마지막 테스트로 둔다 — 여기서 캐시된 토큰이 남아 있으면, 뒤에 오는 테스트가
// 기대하는 "첫 호출은 토큰 발급" 순서가 깨진다. (앞선 테스트들의 가짜 토큰 응답엔 expires_in이
// 없어서 캐시되지 않는다.)
test('접근 토큰은 만료 전까지 재사용한다 (두 번 호출해도 토큰 발급 요청은 한 번)', async () => {
  installFetchMock([
    { body: { access_token: 'cached-tok', expires_in: 14400 } },
    { body: { link: 'https://dl.dropboxusercontent.com/apitl/1/x' } },
    { body: { link: 'https://dl.dropboxusercontent.com/apitl/1/y' } },
  ]);
  await dropbox.getTemporaryLink('/videos/x.mp4');
  await dropbox.getTemporaryLink('/videos/y.mp4');
  assert.equal(calls.filter(c => /oauth2\/token/.test(c.url)).length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].opts.headers.Authorization, 'Bearer cached-tok');
});
