# 드롭박스 보안 재생 + 시청 기간 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 학원 학생 전용 보충 영상을 드롭박스에 두고 `lecture.html` 안에서 재생한다. 재생 주소는 로그인·접근권한·시청 기간 확인을 통과했을 때만 4시간짜리 임시 주소로 발급하고, 재생기는 이름·아이디 워터마크와 다운로드 억제를 갖춘다. 선생님은 영상마다 시청 기간을 정한다.

**Architecture:** 선생님은 드롭박스 앱 폴더의 `videos/`에 파일을 직접 넣고, 관리자 화면에서 목록을 보고 고른다(`video.dropboxPath`). 학생 목록 응답에는 경로 대신 `playable`/`availability`만 내려가고, 재생 화면이 열리면 `api/videos/play-url`이 새 모듈 `api/_lib/playback.js`로 "이 사람 목록에 보이는 영상인지 + 기간 안인지"를 확인한 뒤 드롭박스 임시 주소를 준다. 영상 데이터는 드롭박스 → 학생으로 직접 가서 Vercel 전송량을 쓰지 않는다.

**Tech Stack:** Vercel Serverless Functions(Node ESM), Upstash Redis, 드롭박스 HTTP API(내장 `fetch`, 신규 의존성 없음), `node:test` + `node:assert/strict`, 단일 파일 바닐라 JS 화면(`lecture.html`, `index.html`).

**Spec:** [docs/superpowers/specs/2026-09-10-dropbox-video-playback-design.md](../specs/2026-09-10-dropbox-video-playback-design.md)

## Global Constraints

- Vercel Hobby 서버리스 함수 12개 한도가 이미 꽉 찼다 — **`api/` 아래에 새 함수 파일을 만들지 않는다.** 새 액션은 기존 `api/videos/[action].js`에 추가. `api/_lib/*`는 함수로 세지 않으므로 새로 만들어도 된다.
- **`dropboxPath`는 학생·회원에게 가는 어떤 응답에도 절대 포함하지 않는다** (관리자 `list` 응답에만 있음).
- 시청 기간은 **한국 시간 기준**: 시작일 `T00:00:00+09:00`부터, 종료일 `T23:59:59.999+09:00`까지. 서버가 UTC로 돌기 때문에 `+09:00`을 반드시 명시.
- 허용 영상 경로: `/videos/`로 시작(대소문자 무시), `..` 없음, 500자 이하, 확장자 `.mp4 .m4v .mov .webm`.
- 드롭박스 열쇠(`DROPBOX_APP_KEY`/`DROPBOX_APP_SECRET`/`DROPBOX_REFRESH_TOKEN`)는 사용자가 Vercel 대시보드에 직접 넣는다. 코드에 값을 넣거나 값을 요청하지 않는다.
- 모든 상태 변경 POST 액션은 기존대로 `isSameOrigin(req)` 검사.
- 화면 문구는 아래 그대로 쓴다: `볼 수 없는 영상입니다` / `아직 영상이 준비되지 않았습니다`(서버) · `아직 영상이 준비되지 않았어요`(재생 화면) / `M월 D일부터 볼 수 있어요` / `시청 기간이 끝났어요` / `영상을 불러오지 못했습니다` / `드롭박스가 아직 연결되지 않았습니다` / `시작일이 종료일보다 늦습니다` / 억제 안내 `🔒 {이름}님 전용 영상입니다. 녹화하거나 공유하면 화면에 표시된 이름으로 누구인지 확인됩니다.`
- 테스트는 `npm test`(= `node --experimental-test-module-mocks --test tests/*.test.mjs`). 가짜 Redis의 `get()`은 반드시 깊은 복제(`JSON.parse(JSON.stringify(...))`)로 반환.
- 커밋은 `main`에 직접(이 저장소 관례). 메시지 끝에 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- `lecture.html`/`index.html`은 크고 줄 번호가 자주 바뀐다 — 계획의 줄 번호는 참고용이고, **보여준 기존 코드 조각을 그대로 찾아서** 고친다.

---

## File Structure

**Create**
- `api/_lib/playback.js` — "이 사람 목록에 보이는 영상" 판정 + 재생 주소 발급 판정(유일한 기준)
- `tests/video-availability.test.mjs` — 영상 모듈(기간·경로 검증·목록 모양) 단위 테스트
- `tests/playback.test.mjs` — `api/videos/[action].js`의 `play-url`/`dropbox-list`/`mine`/`save` 테스트

**Modify**
- `api/_lib/dropbox.js` — 폴더 목록, 임시 주소, 토큰 캐시, 미연결 오류 코드
- `api/_lib/video.js` — `dropboxPath`/`availableFrom`/`availableUntil` 필드, `getAvailability`, `isValidDropboxVideoPath`, 학생 목록 모양
- `api/_lib/course.js` — 회원 강좌 목록 모양
- `api/videos/[action].js` — `mine`을 `playback.js`로, `play-url`·`dropbox-list` 추가, `save` 날짜 검증
- `tests/dropbox.test.mjs` — 새 드롭박스 함수 테스트 추가
- `lecture.html` — 목록 기간 표시, 자체 컨트롤 재생기 + 워터마크 + 안내 문구
- `index.html` — 영상 폼(드롭박스 고르기, 시청 기간), 영상 목록 표

---

### Task 1: 드롭박스 모듈 — 폴더 목록·임시 주소·토큰 캐시

**Files:**
- Modify: `api/_lib/dropbox.js`
- Test: `tests/dropbox.test.mjs` (기존 파일 끝에 추가)

**Interfaces:**
- Produces:
  - `listVideoFolder(): Promise<{ files: Array<{ path: string, name: string, size: number }>, folderMissing: boolean }>` — 앱 폴더의 `/videos`를 하위 폴더 없이 끝까지 읽어 **파일만**(폴더 제외) 이름순으로. 확장자 필터는 하지 않는다(영상 판정은 Task 2의 `isValidDropboxVideoPath` 몫). 폴더가 없으면 `{ files: [], folderMissing: true }`.
  - `getTemporaryLink(path: string): Promise<string>` — 4시간짜리 직접 재생 주소. 실패 시 throw.
  - 열쇠 환경변수가 없으면 모든 드롭박스 함수가 `err.code === 'NOT_CONFIGURED'`인 Error를 throw.
- 기존 `uploadReviewImage`, `REVIEW_IMAGE_LIMITS`는 이름·동작 그대로.

- [ ] **Step 1: 실패하는 테스트 추가**

`tests/dropbox.test.mjs` 맨 끝(기존 마지막 테스트 뒤)에 추가:

```js
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
  await assert.rejects(() => dropbox.getTemporaryLink('/videos/없음.mp4'));
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-test-module-mocks --test tests/dropbox.test.mjs`
Expected: 새 테스트들이 FAIL (`dropbox.listVideoFolder is not a function` 등). 기존 4개는 PASS.

- [ ] **Step 3: 구현**

`api/_lib/dropbox.js`에서 `requireEnv`와 `getAccessToken`을 아래로 **교체**:

```js
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    const err = new Error(`${name} 환경변수가 설정되지 않았습니다`);
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return v;
}

// 접근 토큰은 약 4시간 유효하다. "재생 버튼을 누르면 바로 시작"하도록 매 요청마다 새로 받지 않고
// 같은 서버 인스턴스 안에서 만료 1분 전까지 재사용한다. 만료 정보(expires_in)가 없는 응답은
// 캐시하지 않는다 — 언제 죽을지 모르는 토큰을 무기한 재사용하는 것보다 매번 받는 게 안전.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) return cachedToken;
  const appKey = requireEnv('DROPBOX_APP_KEY');
  const appSecret = requireEnv('DROPBOX_APP_SECRET');
  const refreshToken = requireEnv('DROPBOX_REFRESH_TOKEN');
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    }),
  });
  if (!res.ok) throw new Error('드롭박스 인증에 실패했습니다');
  const data = await res.json();
  if (data.expires_in) {
    cachedToken = data.access_token;
    cachedTokenExpiresAt = Date.now() + data.expires_in * 1000;
  }
  return data.access_token;
}
```

그리고 파일 **맨 끝**에 추가:

```js
async function rpc(accessToken, endpoint, body) {
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 선생님이 드롭박스 앱 폴더의 videos/에 직접 넣은 파일 목록. 무엇이 "영상 파일"인지는
// video.js(isValidDropboxVideoPath)가 판단한다 — 이 모듈은 드롭박스를 읽기만 한다.
export async function listVideoFolder() {
  const accessToken = await getAccessToken();
  let r = await rpc(accessToken, 'files/list_folder', { path: '/videos', recursive: false });
  if (!r.ok) {
    if (String(r.data?.error_summary || '').startsWith('path/not_found')) return { files: [], folderMissing: true };
    throw new Error('드롭박스 목록을 불러오지 못했습니다');
  }
  const entries = [...(r.data.entries || [])];
  while (r.data.has_more) {
    r = await rpc(accessToken, 'files/list_folder/continue', { cursor: r.data.cursor });
    if (!r.ok) throw new Error('드롭박스 목록을 불러오지 못했습니다');
    entries.push(...(r.data.entries || []));
  }
  const files = entries
    .filter(e => e['.tag'] === 'file')
    .map(e => ({ path: e.path_display, name: e.name, size: e.size || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return { files, folderMissing: false };
}

// 4시간 뒤 자동으로 죽는 직접 재생 주소. 구간 요청을 지원해서 <video>에서 건너뛰기 재생이 된다.
// 주소는 저장하지 않고 재생할 때마다 새로 발급한다(playback.js).
export async function getTemporaryLink(path) {
  const accessToken = await getAccessToken();
  const r = await rpc(accessToken, 'files/get_temporary_link', { path });
  if (!r.ok || !r.data?.link) throw new Error('드롭박스 임시 주소 발급에 실패했습니다');
  return r.data.link;
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --experimental-test-module-mocks --test tests/dropbox.test.mjs`
Expected: PASS, 10 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/dropbox.js tests/dropbox.test.mjs
git commit -m "$(cat <<'EOF'
드롭박스 영상 폴더 목록·임시 재생 주소 발급·토큰 재사용 추가

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 영상 모듈 — 시청 기간·경로 검증·목록 모양

**Files:**
- Modify: `api/_lib/video.js`, `api/_lib/course.js`
- Test: `tests/video-availability.test.mjs` (신규)

**Interfaces:**
- Consumes: 없음 (Task 1과 독립 — `video.js`는 `dropbox.js`를 import하지 **않는다**. import하면 드롭박스를 가짜로 바꿔 끼우는 기존 `tests/review.test.mjs`가 깨진다.)
- Produces (`api/_lib/video.js`):
  - `getAvailability(video: { availableFrom?: string, availableUntil?: string }, now?: number): 'open' | 'upcoming' | 'ended'`
  - `isValidDropboxVideoPath(raw: any): boolean`
  - video 레코드 필드 `dropboxPath: string`, `availableFrom: string`, `availableUntil: string` (`''` 또는 검증된 값)
  - `listVideosForStudent(schoolId, studentId, now?)` 각 항목: `dropboxPath` **없음**, `playable: boolean`, `availability`, `availableFrom`, `availableUntil` 추가
- Produces (`api/_lib/course.js`): `listVideosForEntitlements(entitlements)` 각 항목에 같은 네 필드 추가, `dropboxPath` 없음

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/video-availability.test.mjs`:

```js
// 영상 시청 기간(한국 시간 경계)·드롭박스 경로 검증·학생/회원 목록 응답 모양 테스트.
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) { const existed = store.has(key); store.delete(key); return existed ? 1 : 0; },
  };
}

const fakeRedis = makeFakeRedis();
before(() => {
  mock.module('../api/_lib/redis.js', { namedExports: { getRedis: () => fakeRedis } });
});

const video = await import('../api/_lib/video.js');
const course = await import('../api/_lib/course.js');

test('getAvailability: 날짜가 없으면 항상 open', () => {
  assert.equal(video.getAvailability({}), 'open');
  assert.equal(video.getAvailability({ availableFrom: '', availableUntil: '' }), 'open');
});

test('getAvailability: 종료일은 한국 시간 그날 23:59:59까지 open', () => {
  const v = { availableUntil: '2026-09-20' };
  assert.equal(video.getAvailability(v, Date.parse('2026-09-20T14:59:59Z')), 'open');
  assert.equal(video.getAvailability(v, Date.parse('2026-09-20T15:00:00Z')), 'ended');
});

test('getAvailability: 시작일은 한국 시간 그날 0시부터 open', () => {
  const v = { availableFrom: '2026-09-15' };
  assert.equal(video.getAvailability(v, Date.parse('2026-09-14T14:59:59Z')), 'upcoming');
  assert.equal(video.getAvailability(v, Date.parse('2026-09-14T15:00:00Z')), 'open');
});

test('isValidDropboxVideoPath: videos 폴더 안의 영상 확장자만 허용', () => {
  assert.equal(video.isValidDropboxVideoPath('/videos/2월1주 해설.mp4'), true);
  assert.equal(video.isValidDropboxVideoPath('/Videos/lecture.MOV'), true);
  assert.equal(video.isValidDropboxVideoPath('/review-images/a.mp4'), false, 'videos 폴더 밖');
  assert.equal(video.isValidDropboxVideoPath('/videos/../review-images/a.mp4'), false, '상위 폴더 이동');
  assert.equal(video.isValidDropboxVideoPath('/videos/notes.pdf'), false, '영상 확장자 아님');
  assert.equal(video.isValidDropboxVideoPath(''), false);
});

test('saveVideo: 잘못된 경로·날짜 형식은 빈 값으로 저장되고 정상 값은 유지된다', async () => {
  const bad = await video.saveVideo({ title: '잘못된 입력', dropboxPath: '/review-images/x.mp4', availableFrom: '2026/09/15', availableUntil: '9월 20일' });
  assert.equal(bad.dropboxPath, '');
  assert.equal(bad.availableFrom, '');
  assert.equal(bad.availableUntil, '');
  const ok = await video.saveVideo({ title: '정상 입력', dropboxPath: '/videos/해설.mp4', availableFrom: '2026-09-15', availableUntil: '2026-09-20' });
  assert.equal(ok.dropboxPath, '/videos/해설.mp4');
  assert.equal(ok.availableFrom, '2026-09-15');
  assert.equal(ok.availableUntil, '2026-09-20');
});

test('listVideosForStudent: dropboxPath는 절대 내려가지 않고 playable/availability가 붙는다', async () => {
  await video.saveVideo({ id: 'vs1', title: '드롭박스 영상', dropboxPath: '/videos/a.mp4', allowSchoolIds: ['schA'], availableUntil: '2020-01-01' });
  await video.saveVideo({ id: 'vs2', title: '파일 없는 영상', allowSchoolIds: ['schA'] });
  const list = await video.listVideosForStudent('schA', 'stuA');
  const v1 = list.find(v => v.id === 'vs1');
  const v2 = list.find(v => v.id === 'vs2');
  assert.equal('dropboxPath' in v1, false, '학생 목록에 드롭박스 경로가 새면 안 됨');
  assert.equal(v1.playable, true);
  assert.equal(v1.availability, 'ended');
  assert.equal(v1.availableUntil, '2020-01-01');
  assert.equal(v2.playable, false);
  assert.equal(v2.availability, 'open');
});

test('listVideosForEntitlements: 회원 강좌 목록도 dropboxPath 없이 playable/availability가 붙는다', async () => {
  await video.saveVideo({ id: 've1', title: '강좌 영상', dropboxPath: '/videos/c.mp4', availableFrom: '2099-01-01' });
  const crs = await course.saveCourse({ title: '드롭박스 강좌', published: true, videoIds: ['ve1'] });
  const list = await course.listVideosForEntitlements([
    { courseId: crs.id, status: 'active', expiresAt: new Date(Date.now() + 864e5).toISOString() },
  ]);
  assert.equal(list.length, 1);
  assert.equal('dropboxPath' in list[0], false);
  assert.equal(list[0].playable, true);
  assert.equal(list[0].availability, 'upcoming');
  assert.equal(list[0].availableFrom, '2099-01-01');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-test-module-mocks --test tests/video-availability.test.mjs`
Expected: FAIL (`video.getAvailability is not a function` 등)

- [ ] **Step 3: `api/_lib/video.js` 구현**

(a) `const DOWNLOAD_POLICIES = ['disabled', 'provider_offline'];` 줄 **바로 아래**에 추가:

```js
// 드롭박스 앱 폴더 안 videos/ 아래의, 브라우저에서 재생 가능한 확장자만 영상 파일로 인정한다.
const DROPBOX_VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm'];

export function isValidDropboxVideoPath(raw) {
  const path = String(raw || '').trim();
  const lower = path.toLowerCase();
  if (!lower.startsWith('/videos/') || path.includes('..') || path.length > 500) return false;
  return DROPBOX_VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function normalizeDate(raw) {
  const s = String(raw || '').trim();
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00+09:00`)) ? s : '';
}

// 시청 기간은 한국 시간 기준 — Vercel 서버는 UTC로 돌기 때문에 +09:00을 명시해서 계산한다.
// 시작일은 그날 0시부터, 종료일은 그날 23:59:59.999까지 볼 수 있다. 날짜가 없으면 제한 없음.
export function getAvailability(video, now = Date.now()) {
  const from = video?.availableFrom ? Date.parse(`${video.availableFrom}T00:00:00+09:00`) : null;
  const until = video?.availableUntil ? Date.parse(`${video.availableUntil}T23:59:59.999+09:00`) : null;
  if (from !== null && now < from) return 'upcoming';
  if (until !== null && now > until) return 'ended';
  return 'open';
}
```

(b) `normalizeVideo`의 `downloadPolicy: ...` 줄 **바로 아래**(`createdAt` 줄 위)에 추가:

```js
    dropboxPath: isValidDropboxVideoPath(incoming.dropboxPath) ? String(incoming.dropboxPath).trim() : '',
    availableFrom: normalizeDate(incoming.availableFrom),
    availableUntil: normalizeDate(incoming.availableUntil),
```

(c) 기존 `listVideosForStudent`와 그 위 주석을 통째로 교체:

```js
// note는 관리자 전용 메모, dropboxPath는 재생 주소 발급(playback.js)에만 쓰는 내부 경로 — 학생
// 응답에서는 절대 내려보내지 않는다. 대신 재생 가능 여부(playable)와 시청 기간 상태만 준다.
export async function listVideosForStudent(schoolId, studentId, now = Date.now()) {
  const all = await listAllVideos();
  return all
    .filter(v => canStudentAccessVideo(v, schoolId, studentId))
    .map(({ excludeStudentIds, includeStudentIds, allowSchoolIds, note, dropboxPath, ...rest }) => ({
      ...rest,
      availableFrom: rest.availableFrom || '',
      availableUntil: rest.availableUntil || '',
      playable: !!dropboxPath,
      availability: getAvailability(rest, now),
    }));
}
```

- [ ] **Step 4: `api/_lib/course.js` 구현**

(a) 두 번째 줄 `import { listAllVideos } from './video.js';`를 교체:

```js
import { listAllVideos, getAvailability } from './video.js';
```

(b) `listVideosForEntitlements` 안의 `result.push({ ... });`를 교체:

```js
      result.push({
        id: v.id, title: v.title, month: v.month, week: v.week, mediaKey: v.mediaKey,
        courseId: course.id, courseTitle: course.title,
        downloadPolicy: resolveDownloadPolicy(v, course),
        // dropboxPath는 내보내지 않는다 — 재생 주소는 playback.js가 확인 후 따로 발급.
        availableFrom: v.availableFrom || '', availableUntil: v.availableUntil || '',
        playable: !!v.dropboxPath,
        availability: getAvailability(v),
      });
```

- [ ] **Step 5: 통과 확인**

Run: `node --experimental-test-module-mocks --test tests/video-availability.test.mjs`
Expected: PASS, 7 tests.

Run: `npm test`
Expected: 전체 PASS, 0 fail (기존 course/watch/review 테스트 포함).

- [ ] **Step 6: Commit**

```bash
git add api/_lib/video.js api/_lib/course.js tests/video-availability.test.mjs
git commit -m "$(cat <<'EOF'
영상에 드롭박스 파일·시청 기간 필드 추가, 목록 응답에서 파일 경로 제외

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 재생 주소 발급 — `playback.js` + 영상 API 액션

**Files:**
- Create: `api/_lib/playback.js`
- Modify: `api/videos/[action].js` (파일 전체 교체)
- Test: `tests/playback.test.mjs` (신규)

**Interfaces:**
- Consumes: Task 1 `listVideoFolder()`, `getTemporaryLink(path)` / Task 2 `getAvailability`, `isValidDropboxVideoPath`, `listVideosForStudent`, `listVideosForEntitlements` / 기존 `getVideo`(video.js), `getOwnerEntitlements`·`parseStudentOwnerId`·`makeStudentOwnerId`(entitlements.js), `requireOwnerSession`·`requireStudentSession`·`requireAdminSessionOrApiToken`·`isSameOrigin`·`checkRateLimit(namespace, key, limit, windowSec)`(auth.js)
- Produces:
  - `listVisibleVideosForOwner(owner: { ownerType: 'student'|'member', ownerId: string }): Promise<Video[]>` — 학생: 학교 배정 영상 + 수강권 강좌 영상(중복 제거, 학교 영상 먼저). 회원: 수강권 강좌 영상.
  - `resolvePlayUrl(owner, videoId, now?): Promise<{ ok: true, url: string } | { ok: false, status: number, message: string }>`
  - HTTP `GET /api/videos/play-url?videoId=` → 200 `{ success, url }` / 401 / 400 / 404 / 403 / 429 / 502, 헤더 `Cache-Control: no-store`
  - HTTP `GET /api/videos/dropbox-list` (관리자) → 200 `{ success, files, folderMissing }` / 401 / 503 / 502
  - HTTP `POST /api/videos/save` → 두 날짜 모두 `YYYY-MM-DD`이고 시작일 > 종료일이면 400 `시작일이 종료일보다 늦습니다`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/playback.test.mjs`:

```js
// 드롭박스 재생 주소 발급(play-url)·파일 목록(dropbox-list)·학생 목록(mine)·저장 검증 테스트.
// 드롭박스는 네트워크를 타지 않게 module mock으로, Redis는 기존 테스트와 같은 가짜 클라이언트로 대체.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) { const existed = store.has(key); store.delete(key); return existed ? 1 : 0; },
    async incr(key) { const v = (store.get(key) || 0) + 1; store.set(key, v); return v; },
    async expire() { return 1; },
  };
}

function makeRes() {
  const res = {
    statusCode: 200, body: undefined, headers: {},
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
    end() { return res; },
    setHeader(k, v) { res.headers[k] = v; },
  };
  return res;
}

const fakeRedis = makeFakeRedis();
process.env.API_AUTH_TOKEN = 'test-admin-token';

let tempLinkCalls = [];
let folderImpl = async () => ({ files: [], folderMissing: false });

before(() => {
  mock.module('../api/_lib/redis.js', { namedExports: { getRedis: () => fakeRedis } });
  mock.module('../api/_lib/dropbox.js', {
    namedExports: {
      getTemporaryLink: async (path) => { tempLinkCalls.push(path); return `https://dl.dropboxusercontent.com/apitl/1/${encodeURIComponent(path)}`; },
      listVideoFolder: (...args) => folderImpl(...args),
      uploadReviewImage: async () => '',
      REVIEW_IMAGE_LIMITS: { MAX_IMAGE_BYTES: 0, MAX_IMAGES_PER_REVIEW: 0 },
    },
  });
});
beforeEach(() => { tempLinkCalls = []; });

const auth = await import('../api/_lib/auth.js');
const video = await import('../api/_lib/video.js');
const course = await import('../api/_lib/course.js');
const videoHandler = (await import('../api/videos/[action].js')).default;

const SCHOOL = 'sch_pb';

async function seedStudent(studentId) {
  const sc = (await fakeRedis.get('school:' + SCHOOL)) || { id: SCHOOL, name: '재생테스트고', version: 0, students: [], withdrawnStudents: [] };
  sc.students = sc.students.filter(s => s.id !== studentId).concat([{ id: studentId, name: '학생' + studentId, entitlements: [] }]);
  await fakeRedis.set('school:' + SCHOOL, sc);
  const { token } = await auth.createSession({ role: 'student', schoolId: SCHOOL, studentId });
  return `oheng_session=${token}`;
}

async function playUrl(cookie, videoId) {
  const res = makeRes();
  await videoHandler({ method: 'GET', headers: cookie ? { cookie } : {}, query: { action: 'play-url', videoId } }, res);
  return res;
}

test('play-url: 비로그인은 401이고 드롭박스를 부르지 않는다', async () => {
  await video.saveVideo({ id: 'pv-open', title: '열린 영상', dropboxPath: '/videos/open.mp4', allowSchoolIds: [SCHOOL] });
  const res = await playUrl(null, 'pv-open');
  assert.equal(res.statusCode, 401);
  assert.equal(tempLinkCalls.length, 0);
});

test('play-url: 허용된 학생은 임시 주소를 받고, 캐시 금지 헤더가 붙는다', async () => {
  const cookie = await seedStudent('stu_ok');
  const res = await playUrl(cookie, 'pv-open');
  assert.equal(res.statusCode, 200);
  assert.match(res.body.url, /^https:\/\/dl\.dropboxusercontent\.com\//);
  assert.deepEqual(tempLinkCalls, ['/videos/open.mp4']);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('play-url: 허용 안 된 학교의 학생은 404 (영상 존재 여부도 드러내지 않음)', async () => {
  await video.saveVideo({ id: 'pv-other', title: '다른 학교 영상', dropboxPath: '/videos/other.mp4', allowSchoolIds: ['sch_elsewhere'] });
  const cookie = await seedStudent('stu_no');
  const res = await playUrl(cookie, 'pv-other');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, '볼 수 없는 영상입니다');
  assert.equal(tempLinkCalls.length, 0);
});

test('play-url: 학생 예외로 차단된 학생은 404', async () => {
  await video.saveVideo({ id: 'pv-excl', title: '예외 차단 영상', dropboxPath: '/videos/excl.mp4', allowSchoolIds: [SCHOOL], excludeStudentIds: ['stu_blocked'] });
  const cookie = await seedStudent('stu_blocked');
  const res = await playUrl(cookie, 'pv-excl');
  assert.equal(res.statusCode, 404);
});

test('play-url: 파일이 지정 안 된 영상은 404', async () => {
  await video.saveVideo({ id: 'pv-nofile', title: '파일 없음', allowSchoolIds: [SCHOOL] });
  const cookie = await seedStudent('stu_ok');
  const res = await playUrl(cookie, 'pv-nofile');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, '아직 영상이 준비되지 않았습니다');
});

test('play-url: 기간이 끝났거나 시작 전이면 403이고 드롭박스를 부르지 않는다', async () => {
  await video.saveVideo({ id: 'pv-ended', title: '끝난 영상', dropboxPath: '/videos/ended.mp4', allowSchoolIds: [SCHOOL], availableUntil: '2020-01-01' });
  await video.saveVideo({ id: 'pv-soon', title: '예정 영상', dropboxPath: '/videos/soon.mp4', allowSchoolIds: [SCHOOL], availableFrom: '2099-03-05' });
  const cookie = await seedStudent('stu_ok');
  const ended = await playUrl(cookie, 'pv-ended');
  assert.equal(ended.statusCode, 403);
  assert.equal(ended.body.message, '시청 기간이 끝났어요');
  const soon = await playUrl(cookie, 'pv-soon');
  assert.equal(soon.statusCode, 403);
  assert.equal(soon.body.message, '3월 5일부터 볼 수 있어요');
  assert.equal(tempLinkCalls.length, 0);
});

test('play-url: 회원은 수강권 있는 강좌의 영상만 재생된다', async () => {
  await video.saveVideo({ id: 'pv-course', title: '강좌 영상', dropboxPath: '/videos/course.mp4' });
  const crs = await course.saveCourse({ title: '재생 강좌', published: true, videoIds: ['pv-course'] });
  const active = [{ courseId: crs.id, status: 'active', expiresAt: new Date(Date.now() + 864e5).toISOString() }];
  await fakeRedis.set('member:mem_has', { id: 'mem_has', name: '회원A', entitlements: active });
  await fakeRedis.set('member:mem_none', { id: 'mem_none', name: '회원B', entitlements: [] });
  const hasCookie = `oheng_session=${(await auth.createSession({ role: 'member', memberId: 'mem_has' })).token}`;
  const noneCookie = `oheng_session=${(await auth.createSession({ role: 'member', memberId: 'mem_none' })).token}`;
  assert.equal((await playUrl(hasCookie, 'pv-course')).statusCode, 200);
  assert.equal((await playUrl(noneCookie, 'pv-course')).statusCode, 404);
});

test('mine: 학생 목록에 드롭박스 경로가 없고 playable/availability가 있다', async () => {
  const cookie = await seedStudent('stu_ok');
  const res = makeRes();
  await videoHandler({ method: 'GET', headers: { cookie }, query: { action: 'mine' } }, res);
  assert.equal(res.statusCode, 200);
  const v = res.body.videos.find(x => x.id === 'pv-open');
  assert.ok(v, '허용된 영상이 목록에 있어야 함');
  assert.equal('dropboxPath' in v, false);
  assert.equal(v.playable, true);
  assert.equal(v.availability, 'open');
});

test('dropbox-list: 관리자만 부를 수 있고, 영상 파일만 걸러서 돌려준다', async () => {
  folderImpl = async () => ({ files: [
    { path: '/videos/a.mp4', name: 'a.mp4', size: 10 },
    { path: '/videos/memo.txt', name: 'memo.txt', size: 1 },
  ], folderMissing: false });
  const anon = makeRes();
  await videoHandler({ method: 'GET', headers: {}, query: { action: 'dropbox-list' } }, anon);
  assert.equal(anon.statusCode, 401);
  const res = makeRes();
  await videoHandler({ method: 'GET', headers: { 'x-api-token': 'test-admin-token' }, query: { action: 'dropbox-list' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.files.map(f => f.name), ['a.mp4']);
  assert.equal(res.body.folderMissing, false);
});

test('dropbox-list: 드롭박스 미연결이면 503', async () => {
  folderImpl = async () => { const e = new Error('없음'); e.code = 'NOT_CONFIGURED'; throw e; };
  const res = makeRes();
  await videoHandler({ method: 'GET', headers: { 'x-api-token': 'test-admin-token' }, query: { action: 'dropbox-list' } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.message, '드롭박스가 아직 연결되지 않았습니다');
});

test('save: 시작일이 종료일보다 늦으면 400', async () => {
  const res = makeRes();
  await videoHandler({
    method: 'POST', headers: { 'x-api-token': 'test-admin-token' },
    body: { title: '기간 오류', availableFrom: '2026-09-20', availableUntil: '2026-09-15' },
    query: { action: 'save' },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, '시작일이 종료일보다 늦습니다');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-test-module-mocks --test tests/playback.test.mjs`
Expected: FAIL (`play-url`/`dropbox-list`가 없어 404 등)

- [ ] **Step 3: `api/_lib/playback.js` 작성**

```js
import { listVideosForStudent, getVideo, getAvailability } from './video.js';
import { listVideosForEntitlements } from './course.js';
import { getOwnerEntitlements, parseStudentOwnerId } from './entitlements.js';
import { getTemporaryLink } from './dropbox.js';

// "이 사람 목록에 보이는 영상"의 유일한 기준. 학생 목록(mine)과 재생 주소 발급(resolvePlayUrl)이
// 둘 다 이 함수를 쓰므로, 목록에 보이는 영상은 재생되고 안 보이는 영상은 재생되지 않는다.
export async function listVisibleVideosForOwner(owner) {
  const entitlements = await getOwnerEntitlements(owner.ownerType, owner.ownerId);
  const courseVideos = entitlements ? await listVideosForEntitlements(entitlements) : [];
  if (owner.ownerType !== 'student') return courseVideos;
  const { schoolId, studentId } = parseStudentOwnerId(owner.ownerId);
  const schoolVideos = await listVideosForStudent(schoolId, studentId);
  const seen = new Set(schoolVideos.map(v => v.id));
  return schoolVideos.concat(courseVideos.filter(v => !seen.has(v.id)));
}

function koreanDate(ymd) {
  const [, m, d] = String(ymd).split('-');
  return `${Number(m)}월 ${Number(d)}일`;
}

// 재생 주소 발급 판정. 목록에 없는 영상은 403이 아니라 404로 답해 존재 여부를 드러내지 않는다.
// 기간 검사는 화면이 아니라 여기서 한다 — 주소 자체를 안 주는 게 진짜 차단.
export async function resolvePlayUrl(owner, videoId, now = Date.now()) {
  const visible = await listVisibleVideosForOwner(owner);
  if (!visible.some(v => v.id === videoId)) return { ok: false, status: 404, message: '볼 수 없는 영상입니다' };
  const video = await getVideo(videoId);
  if (!video || !video.dropboxPath) return { ok: false, status: 404, message: '아직 영상이 준비되지 않았습니다' };
  const availability = getAvailability(video, now);
  if (availability === 'upcoming') return { ok: false, status: 403, message: `${koreanDate(video.availableFrom)}부터 볼 수 있어요` };
  if (availability === 'ended') return { ok: false, status: 403, message: '시청 기간이 끝났어요' };
  try {
    const url = await getTemporaryLink(video.dropboxPath);
    return { ok: true, url };
  } catch {
    return { ok: false, status: 502, message: '영상을 불러오지 못했습니다' };
  }
}
```

- [ ] **Step 4: `api/videos/[action].js` 전체 교체**

기존 `watch-mine`/`watch-confirm`/`list`/`delete`/`watch-admin-list`/`watch-admin-set`은 **한 글자도 바꾸지 않고** 옮겨 담았다. 파일 전체를 아래 내용으로 교체:

```js
import { requireAdminSessionOrApiToken, requireStudentSession, requireOwnerSession, isSameOrigin, checkRateLimit } from '../_lib/auth.js';
import { listAllVideos, saveVideo, deleteVideo, isValidDropboxVideoPath } from '../_lib/video.js';
import { makeStudentOwnerId } from '../_lib/entitlements.js';
import { listWatchStatuses, selfConfirmWatch, teacherSetWatchStatus } from '../_lib/watch.js';
import { listVisibleVideosForOwner, resolvePlayUrl } from '../_lib/playback.js';
import { listVideoFolder } from '../_lib/dropbox.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 영상 카탈로그 + 시청기록 + 드롭박스 재생 라우트. Vercel Hobby 플랜의 서버리스 함수 12개 제한 때문에
// 새 파일로 나누지 않고 이 파일에 액션으로 모아둔다.
// 관리자는 전체 목록/등록/수정/삭제, 학생은 본인이 접근 가능한 영상만 조회·재생.
export default async function handler(req, res) {
  const { action } = req.query;

  if (action === 'mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const session = await requireStudentSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    // 학교가 배정한 영상 + 학생 본인이 직접 구매한 유료 강좌 영상. 재생 주소 발급(play-url)도 같은
    // 함수로 "보이는 영상"을 판정하므로, 목록에 보이는 것과 재생되는 것이 항상 일치한다.
    const videos = await listVisibleVideosForOwner({ ownerType: 'student', ownerId: makeStudentOwnerId(session.schoolId, session.studentId) });
    return res.status(200).json({ success: true, videos });
  }

  // 재생 화면이 열리는 순간 호출 — 로그인·접근권한·시청 기간을 모두 통과해야 4시간짜리 드롭박스
  // 임시 주소를 준다. 주소는 저장하지 않고 매번 새로 발급하며, 응답도 캐시되지 않게 한다.
  if (action === 'play-url') {
    if (req.method !== 'GET') return res.status(405).end();
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!await checkRateLimit('play-url', `${owner.ownerType}:${owner.ownerId}`, 30, 60)) {
      return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });
    }
    const videoId = String(req.query.videoId || '');
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    res.setHeader('Cache-Control', 'no-store');
    const result = await resolvePlayUrl(owner, videoId);
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    return res.status(200).json({ success: true, url: result.url });
  }

  // 여러 영상의 내 시청 상태를 한 번에 조회 — 회원/학생 둘 다.
  if (action === 'watch-mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const videoIds = String(req.query.videoIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoIds.length) return res.status(200).json({ success: true, statuses: {} });
    const statuses = await listWatchStatuses(owner.ownerType, owner.ownerId, videoIds);
    return res.status(200).json({ success: true, statuses });
  }

  // 학생/회원 본인이 "다 봤어요" — 실제 재생 증거는 아니므로 서버가 status를 고정해서 저장.
  if (action === 'watch-confirm') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { videoId } = req.body || {};
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    const record = await selfConfirmWatch(owner.ownerType, owner.ownerId, videoId);
    return res.status(200).json({ success: true, record });
  }

  const admin = await requireAdminSessionOrApiToken(req);
  if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (action === 'list') {
    if (req.method !== 'GET') return res.status(405).end();
    const videos = await listAllVideos();
    return res.status(200).json({ success: true, videos });
  }

  if (action === 'save') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { title, availableFrom, availableUntil } = req.body || {};
    if (!String(title || '').trim()) return res.status(400).json({ success: false, message: '제목을 입력하세요' });
    const from = String(availableFrom || '');
    const until = String(availableUntil || '');
    if (DATE_RE.test(from) && DATE_RE.test(until) && from > until) {
      return res.status(400).json({ success: false, message: '시작일이 종료일보다 늦습니다' });
    }
    const video = await saveVideo(req.body || {});
    return res.status(200).json({ success: true, video });
  }

  if (action === 'delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
    await deleteVideo(id);
    return res.status(200).json({ success: true });
  }

  // 관리자 영상 폼의 "드롭박스에서 고르기" — 앱 폴더 videos/의 파일 중 영상 파일만.
  if (action === 'dropbox-list') {
    if (req.method !== 'GET') return res.status(405).end();
    try {
      const { files, folderMissing } = await listVideoFolder();
      return res.status(200).json({ success: true, files: files.filter(f => isValidDropboxVideoPath(f.path)), folderMissing });
    } catch (e) {
      if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ success: false, message: '드롭박스가 아직 연결되지 않았습니다' });
      return res.status(502).json({ success: false, message: '드롭박스 목록을 불러오지 못했습니다' });
    }
  }

  // 교사(관리자)가 학생 여러 명의 특정 영상 시청 상태를 한 번에 조회.
  if (action === 'watch-admin-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const videoId = String(req.query.videoId || '');
    const schoolId = String(req.query.schoolId || '');
    const studentIds = String(req.query.studentIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoId || !schoolId || !studentIds.length) {
      return res.status(400).json({ success: false, message: 'Missing videoId/schoolId/studentIds' });
    }
    const entries = await Promise.all(studentIds.map(async sid => {
      const ownerId = makeStudentOwnerId(schoolId, sid);
      const [status] = Object.values(await listWatchStatuses('student', ownerId, [videoId]));
      return [sid, status || null];
    }));
    return res.status(200).json({ success: true, statuses: Object.fromEntries(entries) });
  }

  // 교사가 특정 학생/회원의 특정 영상 시청 상태를 직접 지정/정정.
  if (action === 'watch-admin-set') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { ownerType, memberId, schoolId, studentId, videoId, status } = req.body || {};
    if (!videoId || !status) return res.status(400).json({ success: false, message: 'Missing videoId/status' });
    if (!['teacher_confirmed', 'exempt', 'opened'].includes(status)) {
      return res.status(400).json({ success: false, message: '허용되지 않은 status' });
    }
    let resolvedType, resolvedId;
    if (ownerType === 'member' || memberId) { resolvedType = 'member'; resolvedId = memberId; }
    else if (schoolId && studentId) { resolvedType = 'student'; resolvedId = makeStudentOwnerId(schoolId, studentId); }
    if (!resolvedType || !resolvedId) return res.status(400).json({ success: false, message: 'Missing owner 정보' });
    const record = await teacherSetWatchStatus(resolvedType, resolvedId, videoId, status, admin.actorName || admin.actorId || 'admin');
    return res.status(200).json({ success: true, record });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
```

- [ ] **Step 5: 통과 확인 + 함수 개수 확인**

Run: `node --experimental-test-module-mocks --test tests/playback.test.mjs`
Expected: PASS, 11 tests.

Run: `npm test`
Expected: 전체 PASS, 0 fail (특히 `tests/watch.test.mjs` — 같은 핸들러를 쓴다).

Run: `find api -name "*.js" -not -path "*/_lib/*" | wc -l`
Expected: `12`

- [ ] **Step 6: Commit**

```bash
git add api/_lib/playback.js "api/videos/[action].js" tests/playback.test.mjs
git commit -m "$(cat <<'EOF'
드롭박스 재생 주소 발급(play-url)·파일 목록(dropbox-list) 추가, 시청 기간 서버 검증

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 학생 화면 — 기간 표시 + 자체 컨트롤 재생기 + 워터마크

**Files:**
- Modify: `lecture.html`

**Interfaces:**
- Consumes: Task 2/3의 목록 항목 필드 `playable`, `availability`, `availableFrom`, `availableUntil`(학생 `/api/videos/mine`, 회원 `/api/courses/mine` 둘 다) / `GET /api/videos/play-url?videoId=` → `{ success, url }` 또는 `{ success:false, message }` / 기존 `ST.mode`, `ST.student`(`/api/student/me` 응답 — `ST.student.student.id`가 로그인 아이디, `.name`), `ST.member`(`{ name, phone, email }`), `esc()`, `loadAndRenderWatchStatus()`
- Produces: 화면만 (다른 태스크가 의존하는 인터페이스 없음)

이 저장소엔 프론트엔드 자동 테스트가 없다(관례) — 문법 검사 + 브라우저 확인으로 검증한다.

- [ ] **Step 1: CSS 추가**

`  .player-box .sub{font-size:11.5px;color:#7B819A}` 줄 **바로 아래**에 추가:

```css
  .vp-wrap{position:relative;background:#000;border-radius:16px;overflow:hidden;aspect-ratio:16/9;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
  .vp-wrap video{position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain}
  .vp-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#C7C9D6;font-size:13px;pointer-events:none}
  .vp-mark{position:absolute;top:10%;left:6%;z-index:2;color:#fff;opacity:.35;font-size:14px;font-weight:700;white-space:nowrap;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.7);transition:top 1.2s ease,left 1.2s ease}
  .vp-bar{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;align-items:center;gap:10px;padding:10px 12px;background:linear-gradient(transparent,rgba(0,0,0,.75));color:#fff;font-size:12px}
  .vp-bar button{background:none;border:none;color:#fff;font-size:15px;line-height:1;cursor:pointer;padding:4px 6px;font-family:inherit}
  .vp-bar select{background:rgba(0,0,0,.45);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;font-size:11.5px;padding:3px 4px;font-family:inherit}
  .vp-seek{flex:1;min-width:60px;accent-color:var(--coral)}
  .vp-time{font-variant-numeric:tabular-nums;white-space:nowrap}
  .vp-wrap:fullscreen{border-radius:0;aspect-ratio:auto}
  .vp-wrap.vp-fake-fs{position:fixed;inset:0;z-index:1000;border-radius:0;aspect-ratio:auto}
  .vp-notice{margin-top:10px;font-size:12.5px;color:var(--navy-soft);line-height:1.55}
  .vcard-tag{margin-left:auto;font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;background:var(--lightbg);color:var(--navy-soft);white-space:nowrap}
  .vcard-tag.ended{background:#F1F3F5;color:#9BA3AF}
  .vcard.ended{opacity:.6}
  @media (max-width:480px){ .vp-bar{gap:6px;padding:8px} #vp-mute{display:none} .vp-mark{font-size:12px} }
```

- [ ] **Step 2: 목록 카드에 기간 표시**

기존 코드를 찾아서:

```js
function videoCard(v){
  return`<div class="vcard" data-vid="${v.id}">
    <div class="vcard-title">🎬 ${esc(v.title)}</div>
  </div>`;
}
```

아래로 교체:

```js
function shortKDate(ymd){const[,m,d]=String(ymd).split('-');return`${Number(m)}월 ${Number(d)}일`;}

// 시청 기간 표시 — 서버가 계산해 준 availability를 그대로 쓴다(학생 기기 시계는 믿지 않음).
function videoAvailTag(v){
  if(v.availability==='upcoming'&&v.availableFrom)return`<span class="vcard-tag">${shortKDate(v.availableFrom)}부터</span>`;
  if(v.availability==='ended')return`<span class="vcard-tag ended">시청 기간 종료</span>`;
  if(v.availableUntil)return`<span class="vcard-tag">~${shortKDate(v.availableUntil)}까지</span>`;
  return'';
}

function videoCard(v){
  return`<div class="vcard${v.availability==='ended'?' ended':''}" data-vid="${v.id}">
    <div class="vcard-title">🎬 ${esc(v.title)}${videoAvailTag(v)}</div>
  </div>`;
}
```

- [ ] **Step 3: 재생 화면 교체 + 재생기 동작 추가**

기존 코드를 찾아서:

```js
function playerScreen(){
  const v=ST.active;
  const wk=ST.mode==='member'?(v.courseTitle||'강좌'):(v.month&&v.week?`${v.month} ${v.week}`:'기타 자료');
  return`<button class="player-back" id="btn-back">‹ 목록으로</button>
    <div class="player-title">${esc(v.title)}</div>
    <div class="player-wk">${esc(wk)}</div>
    <div class="player-box">
      <div class="ic">🔒</div>
      <div class="msg">재생 준비 중</div>
      <div class="sub">콜러스(Kollus) 연동 후 이곳에서 바로 재생됩니다</div>
    </div>
    <div id="watch-status-wrap" style="margin-top:16px"></div>`;
}
```

아래로 교체:

```js
// 워터마크 문구 — 학생은 이름·로그인 아이디, 회원은 이름·전화번호 뒤 4자리(없으면 가린 이메일).
// 영상이 유출되면 이 문구로 누구 화면인지 확인한다. 전화번호 전체는 유출 시 번호가 퍼지므로 가린다.
function viewerLabel(){
  if(ST.mode==='student'){const s=ST.student?.student||{};return`${s.name||''} · ${s.id||''}`;}
  const m=ST.member||{};
  const digits=String(m.phone||'').replace(/\D/g,'');
  if(digits.length>=4)return`${m.name||''} · ${digits.slice(-4)}`;
  const email=String(m.email||'');const at=email.indexOf('@');
  if(at>0)return`${m.name||''} · ${email.slice(0,2)}***${email.slice(at)}`;
  return m.name||'';
}
function viewerName(){return ST.mode==='student'?(ST.student?.student?.name||''):(ST.member?.name||'');}
function playerStatusBox(icon,msg){return`<div class="player-box"><div class="ic">${icon}</div><div class="msg">${esc(msg)}</div></div>`;}

function playerScreen(){
  const v=ST.active;
  const wk=ST.mode==='member'?(v.courseTitle||'강좌'):(v.month&&v.week?`${v.month} ${v.week}`:'기타 자료');
  let body;
  if(!v.playable)body=playerStatusBox('🎬','아직 영상이 준비되지 않았어요');
  else if(v.availability==='upcoming')body=playerStatusBox('⏳',`${shortKDate(v.availableFrom)}부터 볼 수 있어요`);
  else if(v.availability==='ended')body=playerStatusBox('🔒','시청 기간이 끝났어요');
  else body=`<div class="vp-wrap" id="vp-wrap">
      <video id="vp-video" playsinline disablepictureinpicture preload="metadata"></video>
      <div class="vp-loading" id="vp-loading">영상 불러오는 중...</div>
      <div class="vp-mark" id="vp-mark">${esc(viewerLabel())}</div>
      <div class="vp-bar">
        <button type="button" id="vp-play" aria-label="재생">▶</button>
        <input type="range" class="vp-seek" id="vp-seek" min="0" max="1000" value="0" aria-label="재생 위치">
        <span class="vp-time" id="vp-time">0:00 / 0:00</span>
        <button type="button" id="vp-mute" aria-label="음소거">🔊</button>
        <select id="vp-speed" aria-label="재생 속도"><option value="1">1배</option><option value="1.25">1.25배</option><option value="1.5">1.5배</option><option value="2">2배</option></select>
        <button type="button" id="vp-fs" aria-label="전체화면">⛶</button>
      </div>
    </div>
    <div class="vp-notice">🔒 <b>${esc(viewerName())}님 전용 영상입니다.</b> 녹화하거나 공유하면 화면에 표시된 이름으로 누구인지 확인됩니다.</div>`;
  return`<button class="player-back" id="btn-back">‹ 목록으로</button>
    <div class="player-title">${esc(v.title)}</div>
    <div class="player-wk">${esc(wk)}</div>
    ${body}
    <div id="watch-status-wrap" style="margin-top:16px"></div>`;
}

function fmtTime(s){
  if(!isFinite(s)||s<0)return'0:00';
  s=Math.floor(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60;
  return(h?`${h}:${String(m).padStart(2,'0')}`:`${m}`)+':'+String(sec).padStart(2,'0');
}

async function fetchPlayUrl(videoId){
  const res=await fetch('/api/videos/play-url?videoId='+encodeURIComponent(videoId),{credentials:'include'});
  const d=await res.json().catch(()=>({}));
  if(!res.ok||!d.success)throw new Error(d.message||'영상을 불러오지 못했습니다');
  return d.url;
}

// render()가 화면을 통째로 갈아끼우기 전에 호출 — 워터마크 이동 타이머와 재생 중인 영상을 정리한다.
// 안 치우면 화면을 오갈 때마다 타이머가 쌓인다.
function teardownPlayer(){
  if(ST.vpMarkTimer){clearInterval(ST.vpMarkTimer);ST.vpMarkTimer=null;}
  const video=document.getElementById('vp-video');
  if(video){video.pause();video.removeAttribute('src');video.load();}
}

function showPlayerError(msg){
  teardownPlayer();
  const wrap=document.getElementById('vp-wrap');
  if(wrap)wrap.outerHTML=playerStatusBox('⚠️',msg);
}

// 기본 controls를 쓰지 않는 이유: 다운로드·전체화면 버튼을 끄는 controlsList는 크롬 전용이라
// 사파리·아이폰에선 무시되고, 아이폰 기본 전체화면은 영상만 키워 워터마크가 사라진다.
function wirePlayer(){
  const video=document.getElementById('vp-video');
  if(!video)return;
  const videoId=ST.active.id;
  const wrap=document.getElementById('vp-wrap');
  const loading=document.getElementById('vp-loading');
  const mark=document.getElementById('vp-mark');
  const playBtn=document.getElementById('vp-play');
  const seek=document.getElementById('vp-seek');
  const timeEl=document.getElementById('vp-time');
  const muteBtn=document.getElementById('vp-mute');
  const speedSel=document.getElementById('vp-speed');
  const fsBtn=document.getElementById('vp-fs');
  let seeking=false,retried=false,resumeAt=0;
  const stillHere=()=>ST.screen==='player'&&ST.active?.id===videoId;

  wrap.addEventListener('contextmenu',e=>e.preventDefault());
  const moveMark=()=>{mark.style.top=(5+Math.random()*75)+'%';mark.style.left=(3+Math.random()*55)+'%';};
  moveMark();
  ST.vpMarkTimer=setInterval(moveMark,30000);

  // 로딩 표시는 hidden 속성 대신 style로 숨긴다 — .vp-loading의 display:flex가 hidden을 덮어쓴다.
  const hideLoading=()=>{loading.style.display='none';};
  video.addEventListener('loadedmetadata',()=>{
    hideLoading();
    video.playbackRate=Number(speedSel.value)||1;
    if(resumeAt){video.currentTime=resumeAt;resumeAt=0;}
    timeEl.textContent=`${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  });
  video.addEventListener('timeupdate',()=>{
    if(!seeking&&video.duration)seek.value=String(Math.round(video.currentTime/video.duration*1000));
    timeEl.textContent=`${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  });
  video.addEventListener('play',()=>{hideLoading();playBtn.textContent='❚❚';playBtn.setAttribute('aria-label','일시정지');});
  video.addEventListener('pause',()=>{playBtn.textContent='▶';playBtn.setAttribute('aria-label','재생');});
  video.addEventListener('playing',()=>{retried=false;});
  // 임시 주소는 4시간 뒤 만료된다 — 화면을 오래 열어둬서 재생이 실패하면 한 번만 새 주소로 이어서 재생.
  video.addEventListener('error',async()=>{
    if(!video.getAttribute('src')||!stillHere())return;
    if(retried){showPlayerError('영상을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');return;}
    retried=true;
    resumeAt=video.currentTime||0;
    const wasPlaying=!video.paused;
    try{
      const url=await fetchPlayUrl(videoId);
      if(!stillHere())return;
      video.src=url;
      if(wasPlaying)video.play().catch(()=>{});
    }catch(e){if(stillHere())showPlayerError(e.message);}
  });

  playBtn.addEventListener('click',()=>{if(video.paused)video.play().catch(()=>{});else video.pause();});
  video.addEventListener('click',()=>playBtn.click());
  seek.addEventListener('input',()=>{seeking=true;});
  seek.addEventListener('change',()=>{if(video.duration)video.currentTime=Number(seek.value)/1000*video.duration;seeking=false;});
  muteBtn.addEventListener('click',()=>{video.muted=!video.muted;muteBtn.textContent=video.muted?'🔇':'🔊';});
  speedSel.addEventListener('change',()=>{video.playbackRate=Number(speedSel.value)||1;});
  // 영상이 아니라 재생기 영역(영상+워터마크)을 키워야 전체화면에서도 워터마크가 남는다.
  // 아이폰 사파리는 요소 전체화면을 지원하지 않아 화면을 꽉 채우는 CSS 모드로 대신한다.
  fsBtn.addEventListener('click',()=>{
    if(document.fullscreenElement){document.exitFullscreen().catch(()=>{});return;}
    if(wrap.classList.contains('vp-fake-fs')){wrap.classList.remove('vp-fake-fs');return;}
    if(wrap.requestFullscreen)wrap.requestFullscreen().catch(()=>wrap.classList.add('vp-fake-fs'));
    else wrap.classList.add('vp-fake-fs');
  });

  // 화면이 열리는 즉시 주소를 받아둔다 — 재생 버튼을 누르면 기다림 없이 시작.
  // 아이폰 사파리는 누르기 전엔 영상 정보를 안 받는 경우가 있어, 주소를 받은 뒤엔 안내 문구로 바꾼다.
  fetchPlayUrl(videoId)
    .then(url=>{if(!stillHere())return;video.src=url;loading.textContent='재생 버튼을 눌러주세요';})
    .catch(e=>{if(stillHere())showPlayerError(e.message);});
}
```

- [ ] **Step 4: `render()`와 `wireApp()` 연결**

(a) 기존:

```js
function render(){
  const app=document.getElementById('app');
```

교체:

```js
function render(){
  teardownPlayer();
  const app=document.getElementById('app');
```

(b) `wireApp()` 안의 기존 줄:

```js
  if(ST.screen==='player'&&ST.active)loadAndRenderWatchStatus(ST.active.id);
```

교체:

```js
  if(ST.screen==='player'&&ST.active){loadAndRenderWatchStatus(ST.active.id);wirePlayer();}
```

- [ ] **Step 5: 문법 검사**

Run:
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('lecture.html','utf8');const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);blocks.forEach(b=>new Function(b));console.log('OK: '+blocks.length+' inline script block(s) parse')"
```
Expected: `OK: 1 inline script block(s) parse`

그리고 `npm test` → 전체 PASS (화면 변경이 서버 테스트를 깨지 않는지).

- [ ] **Step 6: Commit**

```bash
git add lecture.html
git commit -m "$(cat <<'EOF'
인강 재생 화면에 보안 재생기(워터마크·자체 컨트롤·억제 안내)와 시청 기간 표시 추가

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 관리자 화면 — 드롭박스 고르기 + 시청 기간

**Files:**
- Modify: `index.html` (영상 관리 탭 — `rVideos(sc)`와 그 바인딩)

**Interfaces:**
- Consumes: `GET /api/videos/dropbox-list` → `{ success, files:[{path,name,size}], folderMissing }` 또는 `{ success:false, message }`(503/502) / `POST /api/videos/save` 본문에 `dropboxPath`, `availableFrom`, `availableUntil` 추가 가능, 400 `시작일이 종료일보다 늦습니다` / 관리자 `list` 응답의 video 레코드(`dropboxPath`, `availableFrom`, `availableUntil` 포함) / 기존 `esc()`, `ST.videos`
- Produces: 화면만

- [ ] **Step 1: 보조 함수 추가**

`function rVideos(sc){` 줄 **바로 위**에 추가:

```js
function dropboxFormatWarn(path){
  if(!path)return'';
  return /\.(mp4|m4v)$/i.test(path)?'':'mp4가 아니면 일부 기기에서 재생되지 않을 수 있어요';
}

// 관리자 목록 표의 시청 기간 요약. 종료 판정은 서버와 같은 한국 시간 경계로 계산한다.
function fmtVideoPeriod(v){
  const f=v.availableFrom||'',u=v.availableUntil||'';
  if(!f&&!u)return'';
  const sd=s=>{const[,m,d]=s.split('-');return`${Number(m)}/${Number(d)}`;};
  if(u&&Date.now()>Date.parse(u+'T23:59:59.999+09:00'))return'<span style="color:#E53935;font-weight:700">기간 종료</span>';
  if(f&&u)return`${sd(f)} ~ ${sd(u)}`;
  if(u)return`~ ${sd(u)}`;
  return`${sd(f)} ~`;
}
```

- [ ] **Step 2: 영상 폼에 드롭박스·기간 칸 추가**

`rVideos` 안 `formHtml`의 기존 코드:

```html
        <div style="font-size:11px;color:#9BA3AF;margin-top:5px">콜러스 계정 연동 전까지는 실제 재생과 무관 — 나중에 발급받은 키를 여기에 넣으면 됩니다.</div>
      </div>
      <div style="margin-bottom:14px"><label class="flbl">허용 학교</label>
```

교체(가운데에 새 블록 삽입):

```html
        <div style="font-size:11px;color:#9BA3AF;margin-top:5px">콜러스 계정 연동 전까지는 실제 재생과 무관 — 나중에 발급받은 키를 여기에 넣으면 됩니다.</div>
      </div>
      <div style="margin-bottom:12px"><label class="flbl">드롭박스 영상 파일</label>
        <input type="hidden" id="vf-dropbox-path" value="${formVideo?esc(formVideo.dropboxPath||''):''}">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
          <span id="vf-dropbox-label" style="font-size:13px;font-weight:600;color:#1A237E">${formVideo?.dropboxPath?esc(formVideo.dropboxPath.split('/').pop()):'선택 안 됨'}</span>
          <button type="button" class="abtn abtn-blue" id="btn-dropbox-pick" style="font-size:11px;padding:5px 10px">📁 드롭박스에서 고르기</button>
          <button type="button" id="btn-dropbox-clear" style="background:none;border:none;color:#9BA3AF;font-size:11px;cursor:pointer;text-decoration:underline">선택 해제</button>
        </div>
        <div id="vf-dropbox-warn" style="font-size:11px;color:#E65100;margin-top:5px">${dropboxFormatWarn(formVideo?.dropboxPath||'')}</div>
        <div id="vf-dropbox-list" style="margin-top:8px"></div>
      </div>
      <div class="form2" style="margin-bottom:6px">
        <div class="fgrp"><label class="flbl">시청 시작일 (선택)</label><input type="date" class="finp" id="vf-from" value="${formVideo?esc(formVideo.availableFrom||''):''}"></div>
        <div class="fgrp"><label class="flbl">시청 종료일 (선택)</label><input type="date" class="finp" id="vf-until" value="${formVideo?esc(formVideo.availableUntil||''):''}"></div>
      </div>
      <div style="font-size:11px;color:#9BA3AF;margin-bottom:12px">비워두면 제한 없이 볼 수 있어요. 한국 시간 기준, 종료일 밤 11시 59분까지.</div>
      <div style="margin-bottom:14px"><label class="flbl">허용 학교</label>
```

- [ ] **Step 3: 안내 문구·목록 표 수정**

(a) 기존 문자열 `실제 재생은 콜러스 연동 후 가능합니다.`를 `드롭박스 영상 파일을 지정하면 학생 화면에서 바로 재생됩니다.`로 교체.

(b) 기존:

```html
      <thead><tr><th style="text-align:left">제목</th><th>주차</th><th>미디어 키</th><th>접근 권한</th><th></th></tr></thead>
```

교체:

```html
      <thead><tr><th style="text-align:left">제목</th><th>주차</th><th>영상 파일</th><th>접근 권한</th><th></th></tr></thead>
```

(c) `listRows` 안의 기존 세 줄:

```html
      <td style="padding:10px 12px;font-weight:700;color:#1A237E">${esc(v.title)}</td>
      <td style="padding:10px 12px;text-align:center;color:#5C6470">${wk}</td>
      <td style="padding:10px 12px;text-align:center">${v.mediaKey?'<span style="color:#00897B;font-weight:700">있음</span>':'<span style="color:#9BA3AF">미등록</span>'}</td>
```

교체:

```html
      <td style="padding:10px 12px;font-weight:700;color:#1A237E">${esc(v.title)}${fmtVideoPeriod(v)?`<div style="font-size:11px;color:#9BA3AF;font-weight:500;margin-top:3px">${fmtVideoPeriod(v)}</div>`:''}</td>
      <td style="padding:10px 12px;text-align:center;color:#5C6470">${wk}</td>
      <td style="padding:10px 12px;text-align:center">${v.dropboxPath?'<span style="color:#00897B;font-weight:700">드롭박스</span>':v.mediaKey?'<span style="color:#5C6470;font-weight:700">키 있음</span>':'<span style="color:#9BA3AF">미등록</span>'}</td>
```

- [ ] **Step 4: 고르기·해제 버튼 동작 추가**

기존 줄(들여쓰기 4칸):

```js
    document.getElementById('btn-video-save')?.addEventListener('click', async()=>{
```

**바로 위**에 추가:

```js
    document.getElementById('btn-dropbox-pick')?.addEventListener('click',async()=>{
      const box=document.getElementById('vf-dropbox-list');
      box.innerHTML='<div style="font-size:12px;color:#9BA3AF">불러오는 중...</div>';
      try{
        const res=await fetch('/api/videos/dropbox-list',{credentials:'include'});
        const d=await res.json().catch(()=>({}));
        if(!res.ok||!d.success){box.innerHTML=`<div style="font-size:12px;color:#E53935">${esc(d.message||'드롭박스 목록을 불러오지 못했습니다')}</div>`;return;}
        if(d.folderMissing){box.innerHTML='<div style="font-size:12px;color:#E65100">드롭박스 앱 폴더 안에 videos 폴더를 만들고 영상을 넣어주세요</div>';return;}
        if(!d.files.length){box.innerHTML='<div style="font-size:12px;color:#9BA3AF">videos 폴더에 영상 파일이 없습니다</div>';return;}
        box.innerHTML=`<div style="max-height:220px;overflow-y:auto;border:1.5px solid #E8ECF0;border-radius:9px;background:#fff">${d.files.map(f=>`<div data-dbx-path="${esc(f.path)}" style="display:flex;justify-content:space-between;gap:10px;padding:8px 12px;font-size:12.5px;cursor:pointer;border-bottom:1px solid #F4F5F7"><span>${esc(f.name)}</span><span style="color:#9BA3AF;white-space:nowrap">${(f.size/1048576).toFixed(1)}MB</span></div>`).join('')}</div>`;
        box.querySelectorAll('[data-dbx-path]').forEach(row=>{
          row.addEventListener('click',()=>{
            const p=row.dataset.dbxPath;
            document.getElementById('vf-dropbox-path').value=p;
            document.getElementById('vf-dropbox-label').textContent=p.split('/').pop();
            document.getElementById('vf-dropbox-warn').textContent=dropboxFormatWarn(p);
            box.innerHTML='';
          });
        });
      }catch(e){box.innerHTML='<div style="font-size:12px;color:#E53935">드롭박스 목록을 불러오지 못했습니다</div>';}
    });
    document.getElementById('btn-dropbox-clear')?.addEventListener('click',()=>{
      document.getElementById('vf-dropbox-path').value='';
      document.getElementById('vf-dropbox-label').textContent='선택 안 됨';
      document.getElementById('vf-dropbox-warn').textContent='';
      document.getElementById('vf-dropbox-list').innerHTML='';
    });
```

- [ ] **Step 5: 저장 요청에 새 필드 추가**

저장 핸들러 안의 기존 코드:

```js
      const body={
        ...(existing||{}),
        title,
        note:(document.getElementById('vf-note')?.value||'').trim(),
        month:document.getElementById('vf-mon')?.value||'',
        week:document.getElementById('vf-wk')?.value||'',
        mediaKey:(document.getElementById('vf-mediakey')?.value||'').trim(),
        allowSchoolIds,
      };
```

교체:

```js
      const availableFrom=document.getElementById('vf-from')?.value||'';
      const availableUntil=document.getElementById('vf-until')?.value||'';
      if(availableFrom&&availableUntil&&availableFrom>availableUntil){if(msgEl){msgEl.textContent='시작일이 종료일보다 늦습니다';msgEl.style.color='#E53935';}return;}
      const body={
        ...(existing||{}),
        title,
        note:(document.getElementById('vf-note')?.value||'').trim(),
        month:document.getElementById('vf-mon')?.value||'',
        week:document.getElementById('vf-wk')?.value||'',
        mediaKey:(document.getElementById('vf-mediakey')?.value||'').trim(),
        dropboxPath:(document.getElementById('vf-dropbox-path')?.value||'').trim(),
        availableFrom,
        availableUntil,
        allowSchoolIds,
      };
```

- [ ] **Step 6: 문법 검사**

Run (index.html엔 인라인 `<script>`가 두 개 — 맨 위 리다이렉트용과 본문 — 라 전부 검사):
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);blocks.forEach(b=>new Function(b));console.log('OK: '+blocks.length+' inline script block(s) parse')"
```
Expected: `OK: 2 inline script block(s) parse`

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
영상 관리에 드롭박스 파일 고르기와 시청 기간 입력 추가

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 전체 확인 + 배포 준비 (컨트롤러가 직접 수행)

**Files:** 없음

- [ ] **Step 1: 전체 테스트·함수 개수·문법**

```bash
npm test
find api -name "*.js" -not -path "*/_lib/*" | wc -l
```
Expected: 전체 PASS·0 fail(기존 52 + 이번 24 = 76 전후), 함수 파일 `12`. Task 4·5의 문법 검사 두 개 재실행 → 둘 다 OK.

- [ ] **Step 2: 배포는 사용자 확인 후**

`git push`는 사용자에게 확인받은 뒤에만 한다(배포 = 다른 사람에게 영향).

- [ ] **Step 3: 배포 후 확인 (드롭박스 열쇠 없어도 가능한 것)**

- 관리자 영상 관리 → 새 영상 추가 폼에 "드롭박스 영상 파일"과 시청 기간 칸이 보이는지, "드롭박스에서 고르기"를 누르면 `드롭박스가 아직 연결되지 않았습니다`가 뜨는지(연결 전이므로 정상).
- 학생 계정으로 인강 목록 → 기존 영상들이 그대로 보이고, 들어가면 `아직 영상이 준비되지 않았어요`가 나오는지.
- `curl "https://oheng.co.kr/api/videos/play-url?videoId=x"` → 401.

- [ ] **Step 4: 사용자에게 드롭박스 연결 안내**

드롭박스 앱을 **App folder** 방식으로 만들고(스펙 "드롭박스 연결 설정" 참고), 열쇠 3개를 Vercel에 등록하고, 앱 폴더에 `videos` 폴더를 만든 뒤 mp4 하나를 넣어 실제 재생·워터마크·전체화면(데스크톱+아이폰)·기간 표시를 확인하도록 안내한다.

---

## 구현 완료 상태 (2026-09-11)

subagent-driven-development로 Task 1~5 구현 → 태스크별 검토 모두 통과 → 최종 전체 검토(opus) "수정 후 병합" → 수정 1회(5건) → 재검토 통과. 로컬 `main` 커밋:

```
19fa47a  드롭박스 영상 폴더 목록·임시 재생 주소 발급·토큰 재사용
d9a823e  영상에 드롭박스 파일·시청 기간 필드, 목록 응답에서 파일 경로 제외
22b9c2f  재생 주소 발급(play-url)·파일 목록(dropbox-list), 시청 기간 서버 검증
cd2569e  학생 재생 화면 — 워터마크·자체 컨트롤·억제 안내·기간 표시
97dfc68  관리자 영상 관리 — 드롭박스 고르기·시청 기간 입력
2a74bdf  최종 리뷰 반영 — 퇴원 학생 재생 차단, 드롭박스 오류 로그, 재생 화면·경로 검증 보완
```

`npm test` 77/77, 서버리스 함수 파일 12개(한도 내).

### 남은 일

1. **`git push`** — 사용자 확인 후.
2. **드롭박스 연결** — 앱 종류는 반드시 **App folder**. 권한(`files.metadata.read`, `files.content.read`, `files.content.write`, `sharing.write`)을 **refresh token 발급 전에** 켜야 한다(나중에 권한을 바꾸면 토큰을 다시 받아야 함). 열쇠 3개를 Vercel(Production+Preview)에 등록하고, 앱 폴더에 `videos` 폴더를 만든다. 연결이 실패하면 Vercel 로그에서 `[dropbox]`로 시작하는 줄을 보면 원인(권한 누락 등)이 찍힌다.
3. **실제 기기 확인** — 워터마크가 데스크톱 전체화면과 아이폰(가짜 전체화면 모드)에서 유지되는지, 목록 기간 표시, 화면을 4시간 넘게 열어뒀다가 재생할 때 이어서 재생되는지, 퇴원 처리한 학생 계정으로 재생이 막히는지.

### 실행 중 내린 결정

- 작업 공간: 별도 브랜치 없이 `main`에 직접 커밋(사용자 결정).
- 스펙과 달리 영상 확장자 거르기를 드롭박스 모듈이 아니라 `dropbox-list`에서 `isValidDropboxVideoPath`로 처리(함수 이름도 `listVideoFolder`) — `video.js`가 `dropbox.js`를 불러오면 기존 후기 테스트가 깨지기 때문. 관리자에게 보이는 결과는 같음.
- 재생기 로딩 표시는 `style.display`로 숨김(`hidden`이 CSS에 덮임), 주소를 받은 뒤엔 `재생 버튼을 눌러주세요` 표시(아이폰은 누르기 전에 영상 정보를 안 받을 수 있음).
- 드롭박스 미연결 오류 코드는 공통 경로(`getAccessToken`)로 모든 함수에 적용되므로 함수별 테스트는 추가하지 않음.
- 목록 응답의 네 필드(`availableFrom/availableUntil/playable/availability`) 매핑이 `video.js`·`course.js` 두 곳에 있음 — 한 줄짜리 네 개라 그대로 둠(아래 "명시적 필드 목록" 과제와 함께 정리 가능).
- 최종 리뷰 수정은 한 번에: 필수 2건(퇴원 학생 차단, 오류 로그) + 같은 파일의 한 줄짜리 3건. 나머지는 아래로 미룸.

### 미뤄둔 항목 (다음에 할 것)

보안·정확성 쪽:
- `listVideosForStudent`를 `course.js`처럼 **보낼 필드를 직접 나열하는 방식**으로 바꾸기 — 지금은 몇 개만 빼고 나머지를 다 보내서, 앞으로 영상에 새 필드를 추가하면 학생에게 기본으로 노출된다.
- 드롭박스가 401을 주면 캐시된 토큰 비우기(드롭박스 쪽에서 토큰을 취소한 경우 최대 4시간 실패).
- `watch-confirm`("다 봤어요")이 볼 수 없는 영상 id도 받음(이번 기능 이전부터 있던 문제).
- `normalizeDate`가 2026-02-31 같은 없는 날짜를 못 거름(관리자 날짜 입력칸에선 생길 수 없음).
- `normalizeVideo`는 저장 시 병합이 아니라 교체 — 필드를 빼고 저장하면 지워짐. API를 직접 쓰는 스크립트를 위해 주석 필요.

화면:
- 아이폰 가짜 전체화면에서 Esc로 나가기·뒤 페이지 스크롤 잠금 없음(실기기 확인 후 판단).
- 주소를 받기 전에 재생을 누르면 반응 없음(안내 문구만 있음).
- 첫 로딩 실패 문구에 "잠시 후 다시 시도해주세요"가 빠져 재시도 실패 문구와 다름.
- 전화번호가 1~3자리뿐인 회원은 이메일 워터마크로 넘어감(휴대폰 인증 회원은 해당 없음).
- 관리자 폼이 다시 그려지면 저장 안 한 드롭박스 선택·기간이 사라짐(기존 폼들과 같은 동작).
- `fmtVideoPeriod`를 행마다 두 번 호출, 드롭박스 목록 응답의 `files`가 항상 배열이라고 가정.

테스트·기타:
- 빠진 테스트: play-url 429/502/videoId 없음 400, dropbox-list 502, 시작일=종료일·한쪽 날짜만 저장, 강좌 영상의 경로 미노출.
- `tests/playback.test.mjs`가 테스트 순서에 의존(첫 테스트가 만든 영상을 뒤에서 씀).
- 500자 경로 제한 테스트 없음, `dropbox.js`의 `size || 0` 대체값은 쓰일 일 없음.
- play-url이 요청마다 전체 영상·강좌를 읽음(학원 규모에선 문제없음).

스펙상 다음 단계: **자동 시청기록 + 선생님용 학생별 시청현황 화면** — 이게 들어가면 "다 봤어요" 버튼은 없앤다.
