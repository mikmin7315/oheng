# 후기 게시판 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `oheng.co.kr`(lecture.html)에 이미지+텍스트 후기와 댓글을 지원하는 공개 후기 게시판을 추가한다. 조회는 누구나, 작성(후기/댓글)은 로그인한 학생 또는 선생님(관리자)만 가능하다.

**Architecture:** 기존 owner 추상화(`requireOwnerSession`)와 Redis `prefix:index`/`prefix:{id}` 패턴을 재사용한다. 이미지는 새로 만드는 `api/_lib/dropbox.js`를 통해 드롭박스에 업로드하고 공유 raw URL만 Redis에 저장한다. 새 API 액션은 Vercel Hobby 12개 함수 한도 때문에 새 파일이 아니라 기존 `api/courses/[action].js`에 추가한다. 관리자(선생님)의 후기 작성/삭제 UI는 `index.html`에, 공개 조회·학생 작성 UI는 `lecture.html`에 만든다.

**Tech Stack:** Vercel Serverless Functions(Node, ESM), Upstash Redis(`@upstash/redis`), 드롭박스 HTTP API(신규 의존성 없이 내장 `fetch` 사용), `node:test` + `node:assert/strict`.

**Spec:** [docs/superpowers/specs/2026-09-09-reviews-board-design.md](../specs/2026-09-09-reviews-board-design.md)

## Global Constraints

- Vercel Hobby 플랜은 배포당 서버리스 함수 12개까지만 허용된다 — 이미 12개를 다 쓰고 있으므로 **새 `api/*.js` 파일을 만들지 말고 `api/courses/[action].js`에 액션을 추가**한다(`api/_lib/*.js`는 함수로 카운트되지 않으므로 자유롭게 추가 가능).
- 테스트는 `npm test` = `node --experimental-test-module-mocks --test tests/*.test.mjs`로 실행한다. 실제 Redis 대신 `mock.module('../api/_lib/redis.js', {...})`로 인메모리 가짜 클라이언트를 주입하는 기존 패턴을 그대로 따른다(`store.get()`은 반드시 깊은 복제로 반환 — 기존 테스트 파일들의 `makeFakeRedis()` 참고).
- 모든 상태 변경 POST 액션은 `isSameOrigin(req)` 체크를 거친다(기존 패턴).
- 공개 API 응답(`review-list`)에는 학생 개인 식별자인 `ownerId`를 절대 포함하지 않는다.
- 후기 텍스트 최대 2000자, 이미지 최대 6장, 이미지 파일당 5MB 이하, MIME은 `image/*`만 허용.
- 드롭박스 시크릿(`DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`)은 사용자가 Vercel 대시보드에 직접 등록한다 — 코드에 값을 하드코딩하거나 대화에서 값을 요청하지 않는다.
- 프론트엔드(`lecture.html`, `index.html`)는 이 저장소에 자동화된 테스트가 없으므로, 해당 태스크는 로컬 dev 서버 + 브라우저로 수동 확인한다(기존 프론트엔드 변경들과 동일한 방식).
- CSS는 기존 토큰(`--navy`, `--navy-soft`, `--coral`, `--coral-dark`, `--border`, `--lightbg`)과 기존 클래스(`.rcard`, `.review-grid`, `.finp`, `.btn`, `.player-back`, `.empty`)를 재사용한다.

---

## File Structure

**Create:**
- `api/_lib/dropbox.js` — 드롭박스 업로드 + 공유링크 발급
- `api/_lib/review.js` — 후기/댓글 Redis 데이터 계층
- `tests/review.test.mjs` — 후기/댓글 API 회귀 테스트

**Modify:**
- `api/courses/[action].js` — `review-list`/`review-create`/`review-image-upload`/`review-delete`/`comment-create`/`comment-delete` 액션 추가, `bodyParser` 크기 제한 상향
- `lecture.html` — 후기 게시판 화면(공개 조회 + 학생 작성), CSS, 네비게이션 연결
- `index.html` — 관리자(선생님) 후기 작성/삭제 화면

---

### Task 1: 드롭박스 이미지 업로드 모듈

**Files:**
- Create: `api/_lib/dropbox.js`
- Test: `tests/dropbox.test.mjs`

**Interfaces:**
- Produces: `uploadReviewImage(dataBase64: string, filename: string, mimeType: string): Promise<string>` — 성공 시 `<img src>`에 바로 쓸 수 있는 raw URL 반환, 실패 시 `Error`(부적절한 타입/용량이면 `err.code`가 `'INVALID_TYPE'`/`'TOO_LARGE'`) throw
- Produces: `REVIEW_IMAGE_LIMITS = { MAX_IMAGE_BYTES: 5*1024*1024, MAX_IMAGES_PER_REVIEW: 6 }`

- [ ] **Step 1: Write the failing test**

`tests/dropbox.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/dropbox.test.mjs`
Expected: FAIL — `Cannot find module '../api/_lib/dropbox.js'`

- [ ] **Step 3: Write minimal implementation**

`api/_lib/dropbox.js`:
```js
// 후기 이미지(카카오톡 캡처 등)를 드롭박스에 저장한다. 영상 전체 카탈로그와 달리 이미지
// 몇 장 수준의 트래픽이라 드롭박스의 대용량 스트리밍 트래픽 스로틀링 정책이 문제되지
// 않는다(2026-09-09 후기 게시판 설계 문서 참고).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_REVIEW = 6;

export const REVIEW_IMAGE_LIMITS = { MAX_IMAGE_BYTES, MAX_IMAGES_PER_REVIEW };

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 환경변수가 설정되지 않았습니다`);
  return v;
}

async function getAccessToken() {
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
  return data.access_token;
}

// 드롭박스 공유링크는 기본적으로 미리보기 페이지(dl=0)를 가리킨다 — <img src>에 바로 쓸 수
// 있도록 raw=1로 바꿔서 원본 파일을 직접 반환하게 한다.
function toRawUrl(shareUrl) {
  return shareUrl.replace('?dl=0', '?raw=1').replace('&dl=0', '&raw=1');
}

async function getOrCreateSharedLink(accessToken, path) {
  const createRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (createRes.ok) {
    const data = await createRes.json();
    return toRawUrl(data.url);
  }
  // 같은 경로에 이미 공유링크가 있으면 create가 409로 실패한다 — 그 경우 기존 링크를 조회한다.
  const listRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, direct_only: true }),
  });
  if (!listRes.ok) throw new Error('드롭박스 공유링크 생성에 실패했습니다');
  const listData = await listRes.json();
  const existing = (listData.links || [])[0];
  if (!existing) throw new Error('드롭박스 공유링크를 찾을 수 없습니다');
  return toRawUrl(existing.url);
}

// dataBase64: 데이터 URL 접두사("data:image/png;base64,") 없이 순수 base64 문자열만 받는다.
export async function uploadReviewImage(dataBase64, filename, mimeType) {
  if (!/^image\//.test(mimeType || '')) {
    const err = new Error('이미지 파일만 업로드할 수 있습니다');
    err.code = 'INVALID_TYPE';
    throw err;
  }
  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) {
    const err = new Error('이미지는 5MB 이하만 업로드할 수 있습니다');
    err.code = 'TOO_LARGE';
    throw err;
  }
  const accessToken = await getAccessToken();
  const safeName = String(filename || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `/review-images/${Date.now()}-${safeName}`;
  const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true, mute: true }),
    },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error('드롭박스 업로드에 실패했습니다');
  const uploaded = await uploadRes.json();
  return await getOrCreateSharedLink(accessToken, uploaded.path_display || path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test tests/dropbox.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add api/_lib/dropbox.js tests/dropbox.test.mjs
git commit -m "$(cat <<'EOF'
후기 이미지용 드롭박스 업로드 모듈 추가

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 후기/댓글 Redis 데이터 계층

**Files:**
- Create: `api/_lib/review.js`
- Test: `tests/review-lib.test.mjs`

**Interfaces:**
- Consumes: `getRedis()` from `api/_lib/redis.js`(기존)
- Produces:
  - `listReviewsForPublic(): Promise<Array<{id,authorType,authorName,text,images,createdAt,comments:[{id,authorType,authorName,text,createdAt}]}>>` — 최신순, `ownerId` 없음
  - `createReview({authorType:'teacher'|'student', authorName, ownerId, text, images}): Promise<Review>` — 실패 시 `err.code==='EMPTY_TEXT'`
  - `deleteReview(id): Promise<void>`
  - `addComment(reviewId, {authorType, authorName, ownerId, text}): Promise<Comment>` — 실패 시 `err.code`가 `'NOT_FOUND'` 또는 `'EMPTY_TEXT'`
  - `deleteComment(reviewId, commentId): Promise<void>`
  - `REVIEW_TEXT_MAX = 2000`, `REVIEW_IMAGES_MAX = 6`

- [ ] **Step 1: Write the failing test**

`tests/review-lib.test.mjs`:
```js
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
const review = await import('../api/_lib/review.js');

test('후기 작성 → 공개 목록에 최신순으로 반영되고 ownerId는 노출되지 않는다', async () => {
  const r1 = await review.createReview({ authorType: 'teacher', authorName: '오은실 대표강사', ownerId: null, text: '첫 후기' });
  const r2 = await review.createReview({ authorType: 'student', authorName: '김학생', ownerId: 'sch1:stu1', text: '두번째 후기', images: ['https://dl.dropboxusercontent.com/a.png'] });

  const list = await review.listReviewsForPublic();
  assert.deepEqual(list.map(r => r.id), [r2.id, r1.id], '최신 작성이 먼저 나와야 함');
  assert.equal(list[0].ownerId, undefined, '공개 목록에는 ownerId가 없어야 함');
  assert.deepEqual(list[0].images, ['https://dl.dropboxusercontent.com/a.png']);
  assert.equal(list[0].comments.length, 0);
});

test('빈 텍스트로 후기를 작성하면 EMPTY_TEXT 에러', async () => {
  await assert.rejects(
    () => review.createReview({ authorType: 'teacher', authorName: '선생님', ownerId: null, text: '   ' }),
    (err) => { assert.equal(err.code, 'EMPTY_TEXT'); return true; }
  );
});

test('댓글 작성 → 해당 후기의 comments에 반영되고, 존재하지 않는 후기면 NOT_FOUND', async () => {
  const r = await review.createReview({ authorType: 'teacher', authorName: '선생님', ownerId: null, text: '댓글 테스트용' });
  const c = await review.addComment(r.id, { authorType: 'student', authorName: '박학생', ownerId: 'sch1:stu2', text: '좋아요' });
  assert.equal(c.authorName, '박학생');

  const list = await review.listReviewsForPublic();
  const found = list.find(x => x.id === r.id);
  assert.equal(found.comments.length, 1);
  assert.equal(found.comments[0].text, '좋아요');
  assert.equal(found.comments[0].ownerId, undefined, '댓글도 ownerId가 공개되면 안 됨');

  await assert.rejects(
    () => review.addComment('no-such-id', { authorType: 'student', authorName: 'x', ownerId: 'a:b', text: 'hi' }),
    (err) => { assert.equal(err.code, 'NOT_FOUND'); return true; }
  );
});

test('관리자 삭제: 후기 삭제 시 댓글도 함께 사라지고, 댓글만 삭제하면 후기는 남는다', async () => {
  const r = await review.createReview({ authorType: 'teacher', authorName: '선생님', ownerId: null, text: '삭제 테스트' });
  const c1 = await review.addComment(r.id, { authorType: 'student', authorName: 'A', ownerId: 'a:1', text: '댓글1' });
  await review.addComment(r.id, { authorType: 'student', authorName: 'B', ownerId: 'a:2', text: '댓글2' });

  await review.deleteComment(r.id, c1.id);
  let list = await review.listReviewsForPublic();
  let found = list.find(x => x.id === r.id);
  assert.equal(found.comments.length, 1);
  assert.equal(found.comments[0].text, '댓글2');

  await review.deleteReview(r.id);
  list = await review.listReviewsForPublic();
  assert.ok(!list.some(x => x.id === r.id));
});

test('이미지는 6장까지만 저장된다', async () => {
  const images = Array.from({ length: 9 }, (_, i) => `https://dl.dropboxusercontent.com/${i}.png`);
  const r = await review.createReview({ authorType: 'teacher', authorName: '선생님', ownerId: null, text: '이미지 개수 제한', images });
  assert.equal(r.images.length, 6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/review-lib.test.mjs`
Expected: FAIL — `Cannot find module '../api/_lib/review.js'`

- [ ] **Step 3: Write minimal implementation**

`api/_lib/review.js`:
```js
import { getRedis } from './redis.js';

const REVIEW_PREFIX = 'review:';
const REVIEW_INDEX_KEY = 'review:index';
const COMMENTS_PREFIX = 'review:comments:';

export const REVIEW_TEXT_MAX = 2000;
export const REVIEW_IMAGES_MAX = 6;

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitizeText(raw, maxLen) {
  return String(raw || '').trim().slice(0, maxLen);
}

export async function getReviewIndex() {
  const redis = getRedis();
  const idx = await redis.get(REVIEW_INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

async function getReview(id) {
  const redis = getRedis();
  return await redis.get(REVIEW_PREFIX + id);
}

async function getComments(reviewId) {
  const redis = getRedis();
  const list = await redis.get(COMMENTS_PREFIX + reviewId);
  return Array.isArray(list) ? list : [];
}

// 공개 응답에는 ownerId(학생 개인 식별자)를 절대 포함하지 않는다.
function publicCommentShape(c) {
  return { id: c.id, authorType: c.authorType, authorName: c.authorName, text: c.text, createdAt: c.createdAt };
}
function publicReviewShape(review, comments) {
  return {
    id: review.id, authorType: review.authorType, authorName: review.authorName,
    text: review.text, images: review.images || [], createdAt: review.createdAt,
    comments: comments.map(publicCommentShape),
  };
}

export async function listReviewsForPublic() {
  const index = await getReviewIndex();
  const reviews = await Promise.all(index.map(async id => {
    const review = await getReview(id);
    if (!review) return null;
    const comments = await getComments(id);
    return publicReviewShape(review, comments);
  }));
  // index는 작성 순서대로 push되므로, 뒤집으면 최신순이 된다.
  return reviews.filter(Boolean).reverse();
}

export async function createReview({ authorType, authorName, ownerId, text, images }) {
  const cleanText = sanitizeText(text, REVIEW_TEXT_MAX);
  if (!cleanText) {
    const err = new Error('후기 내용을 입력하세요');
    err.code = 'EMPTY_TEXT';
    throw err;
  }
  const redis = getRedis();
  const review = {
    id: newId('rev'),
    authorType, authorName: String(authorName || '').trim() || (authorType === 'teacher' ? '선생님' : '학생'),
    ownerId: ownerId || null,
    text: cleanText,
    images: (Array.isArray(images) ? images : []).slice(0, REVIEW_IMAGES_MAX),
    createdAt: new Date().toISOString(),
  };
  await redis.set(REVIEW_PREFIX + review.id, review);
  const index = await getReviewIndex();
  index.push(review.id);
  await redis.set(REVIEW_INDEX_KEY, index);
  return review;
}

export async function deleteReview(id) {
  const redis = getRedis();
  await redis.del(REVIEW_PREFIX + id);
  await redis.del(COMMENTS_PREFIX + id);
  const index = await getReviewIndex();
  await redis.set(REVIEW_INDEX_KEY, index.filter(x => x !== id));
}

export async function addComment(reviewId, { authorType, authorName, ownerId, text }) {
  const review = await getReview(reviewId);
  if (!review) {
    const err = new Error('후기를 찾을 수 없습니다');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const cleanText = sanitizeText(text, REVIEW_TEXT_MAX);
  if (!cleanText) {
    const err = new Error('댓글 내용을 입력하세요');
    err.code = 'EMPTY_TEXT';
    throw err;
  }
  const redis = getRedis();
  const comment = {
    id: newId('cmt'),
    authorType, authorName: String(authorName || '').trim() || (authorType === 'teacher' ? '선생님' : '학생'),
    ownerId: ownerId || null,
    text: cleanText,
    createdAt: new Date().toISOString(),
  };
  const comments = await getComments(reviewId);
  comments.push(comment);
  await redis.set(COMMENTS_PREFIX + reviewId, comments);
  return comment;
}

export async function deleteComment(reviewId, commentId) {
  const redis = getRedis();
  const comments = await getComments(reviewId);
  await redis.set(COMMENTS_PREFIX + reviewId, comments.filter(c => c.id !== commentId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test tests/review-lib.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add api/_lib/review.js tests/review-lib.test.mjs
git commit -m "$(cat <<'EOF'
후기/댓글 Redis 데이터 계층 추가 (review:index, review:{id}, review:comments:{id})

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `api/courses/[action].js`에 후기 액션 연결

**Files:**
- Modify: `api/courses/[action].js`
- Test: `tests/review.test.mjs`

**Interfaces:**
- Consumes: `uploadReviewImage` (Task 1), `listReviewsForPublic`/`createReview`/`deleteReview`/`addComment`/`deleteComment` (Task 2), `requireAdminSessionOrApiToken`/`requireOwnerSession`/`isSameOrigin` (기존 `api/_lib/auth.js`), `getSchool` (기존 `api/_lib/school.js`), `parseStudentOwnerId` (기존 `api/_lib/entitlements.js`)
- Produces: HTTP 액션
  - `GET /api/courses/review-list` (공개) → `{success, reviews}`
  - `POST /api/courses/review-create` (관리자 또는 student 세션) body `{text, images}` → `{success, review}`
  - `POST /api/courses/review-image-upload` (관리자 또는 student 세션) body `{filename, mimeType, dataBase64}` → `{success, url}`
  - `POST /api/courses/comment-create` (관리자 또는 student 세션) body `{reviewId, text}` → `{success, comment}`
  - `POST /api/courses/review-delete` (관리자 전용) body `{id}` → `{success}`
  - `POST /api/courses/comment-delete` (관리자 전용) body `{reviewId, commentId}` → `{success}`

- [ ] **Step 1: Write the failing test**

`tests/review.test.mjs`:
```js
// 후기 게시판 API(courses/[action].js에 합쳐진 review-*/comment-* 액션) 회귀 테스트.
// 드롭박스 업로드는 실제 네트워크를 타지 않도록 module mock으로 대체한다.
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
function makeRes() {
  const res = {
    statusCode: 200, body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
    end() { return res; },
    setHeader() {},
  };
  return res;
}

const fakeRedis = makeFakeRedis();
process.env.API_AUTH_TOKEN = 'test-admin-token';

before(() => {
  mock.module('../api/_lib/redis.js', { namedExports: { getRedis: () => fakeRedis } });
  mock.module('../api/_lib/dropbox.js', {
    namedExports: { uploadReviewImage: async () => 'https://dl.dropboxusercontent.com/mock.png' },
  });
});

const auth = await import('../api/_lib/auth.js');
const courseHandler = (await import('../api/courses/[action].js')).default;

test('비로그인 요청은 review-create/comment-create에서 401', async () => {
  const res1 = makeRes();
  await courseHandler({ method: 'POST', headers: {}, body: { text: '몰래 작성' }, query: { action: 'review-create' } }, res1);
  assert.equal(res1.statusCode, 401);

  const res2 = makeRes();
  await courseHandler({ method: 'POST', headers: {}, body: { reviewId: 'x', text: '몰래 댓글' }, query: { action: 'comment-create' } }, res2);
  assert.equal(res2.statusCode, 401);
});

test('학생 세션으로 후기 작성 → review-list에 반영되고 ownerId는 응답에 없다', async () => {
  const schoolId = 'sch_rv1', studentId = 'stu_rv1';
  await fakeRedis.set('school:' + schoolId, {
    id: schoolId, name: '리뷰테스트고', version: 0,
    students: [{ id: studentId, name: '김리뷰', entitlements: [] }], withdrawnStudents: [],
  });
  const { token } = await auth.createSession({ role: 'student', schoolId, studentId });

  const reqCreate = {
    method: 'POST', headers: { cookie: `oheng_session=${token}` },
    body: { text: '정말 좋은 학원이에요' }, query: { action: 'review-create' },
  };
  const resCreate = makeRes();
  await courseHandler(reqCreate, resCreate);
  assert.equal(resCreate.statusCode, 200);
  assert.equal(resCreate.body.review.authorType, 'student');
  assert.equal(resCreate.body.review.authorName, '김리뷰', '학생 이름이 학교 레코드에서 채워져야 함');

  const resList = makeRes();
  await courseHandler({ method: 'GET', headers: {}, query: { action: 'review-list' } }, resList);
  assert.equal(resList.statusCode, 200);
  const found = resList.body.reviews.find(r => r.id === resCreate.body.review.id);
  assert.ok(found);
  assert.equal(found.ownerId, undefined, '공개 목록 응답에 ownerId가 있으면 안 됨');
});

test('관리자(선생님) 세션으로 후기 작성 → authorType은 teacher', async () => {
  const req = {
    method: 'POST', headers: { 'x-api-token': 'test-admin-token' },
    body: { text: '선생님이 직접 남기는 후기' }, query: { action: 'review-create' },
  };
  const res = makeRes();
  await courseHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.review.authorType, 'teacher');
});

test('이미지 업로드(review-image-upload) → 드롭박스 목 URL 반환 → review-create에서 images로 저장', async () => {
  const reqUpload = {
    method: 'POST', headers: { 'x-api-token': 'test-admin-token' },
    body: { filename: 'a.png', mimeType: 'image/png', dataBase64: 'AAAA' }, query: { action: 'review-image-upload' },
  };
  const resUpload = makeRes();
  await courseHandler(reqUpload, resUpload);
  assert.equal(resUpload.statusCode, 200);
  assert.equal(resUpload.body.url, 'https://dl.dropboxusercontent.com/mock.png');

  const reqCreate = {
    method: 'POST', headers: { 'x-api-token': 'test-admin-token' },
    body: { text: '이미지 첨부 후기', images: [resUpload.body.url] }, query: { action: 'review-create' },
  };
  const resCreate = makeRes();
  await courseHandler(reqCreate, resCreate);
  assert.deepEqual(resCreate.body.review.images, [resUpload.body.url]);
});

test('댓글 작성(comment-create) → 관리자 삭제(review-delete/comment-delete) 정상 동작', async () => {
  const reqCreate = {
    method: 'POST', headers: { 'x-api-token': 'test-admin-token' },
    body: { text: '댓글 달릴 후기' }, query: { action: 'review-create' },
  };
  const resCreate = makeRes();
  await courseHandler(reqCreate, resCreate);
  const reviewId = resCreate.body.review.id;

  const schoolId = 'sch_rv2', studentId = 'stu_rv2';
  await fakeRedis.set('school:' + schoolId, {
    id: schoolId, name: '댓글테스트고', version: 0,
    students: [{ id: studentId, name: '박댓글', entitlements: [] }], withdrawnStudents: [],
  });
  const { token } = await auth.createSession({ role: 'student', schoolId, studentId });
  const reqComment = {
    method: 'POST', headers: { cookie: `oheng_session=${token}` },
    body: { reviewId, text: '저도 다녀요!' }, query: { action: 'comment-create' },
  };
  const resComment = makeRes();
  await courseHandler(reqComment, resComment);
  assert.equal(resComment.statusCode, 200);
  assert.equal(resComment.body.comment.authorName, '박댓글');

  const commentId = resComment.body.comment.id;
  const resDelComment = makeRes();
  await courseHandler(
    { method: 'POST', headers: { 'x-api-token': 'test-admin-token' }, body: { reviewId, commentId }, query: { action: 'comment-delete' } },
    resDelComment
  );
  assert.equal(resDelComment.statusCode, 200);

  const resDelReview = makeRes();
  await courseHandler(
    { method: 'POST', headers: { 'x-api-token': 'test-admin-token' }, body: { id: reviewId }, query: { action: 'review-delete' } },
    resDelReview
  );
  assert.equal(resDelReview.statusCode, 200);

  const resList = makeRes();
  await courseHandler({ method: 'GET', headers: {}, query: { action: 'review-list' } }, resList);
  assert.ok(!resList.body.reviews.some(r => r.id === reviewId));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/review.test.mjs`
Expected: FAIL — 액션들이 아직 없어 404/undefined 관련 assertion 실패

- [ ] **Step 3: Modify `api/courses/[action].js`**

파일 맨 위 import 구역을 다음과 같이 바꾼다(기존 import에 이어서 review/dropbox/school 관련 import와 `config` export 추가):

```js
import { requireAdminSessionOrApiToken, requireMemberSession, requireOwnerSession, isSameOrigin } from '../_lib/auth.js';
import { getMember } from '../_lib/member.js';
import {
  listAllCourses, getCourse, saveCourse, deleteCourse,
  listPublishedCoursesForPublic, listVideosForEntitlements,
  applyToCourse, listApplicants, removeApplicant,
} from '../_lib/course.js';
import { createPendingPayment, verifyAndCompletePayment } from '../_lib/payment.js';
import { getOwnerEntitlements, setOwnerEntitlements, makeStudentOwnerId, parseStudentOwnerId } from '../_lib/entitlements.js';
import { getSchool } from '../_lib/school.js';
import {
  listReviewsForPublic, createReview, deleteReview, addComment, deleteComment,
} from '../_lib/review.js';
import { uploadReviewImage } from '../_lib/dropbox.js';

// 후기 이미지는 base64로 JSON body에 실려오므로(파일당 5MB 이하 기준 base64로는 약 6.7MB),
// 기본 바디 크기 제한을 넉넉히 올려둔다. 이 파일의 다른 액션들은 JSON이 작아 영향 없음.
export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

// 후기/댓글 작성 주체 확인 — 선생님(관리자 세션 또는 API 토큰) 또는 학생 세션만 허용.
// 일반 회원(member)의 후기 작성은 이번 스펙 범위 밖(설계 문서 "범위 밖" 참고).
async function requireReviewAuthor(req, admin) {
  if (admin) {
    return { authorType: 'teacher', authorName: admin.actorName || admin.actorId || '오은실 대표강사', ownerId: null };
  }
  const owner = await requireOwnerSession(req);
  if (!owner || owner.ownerType !== 'student') return null;
  const { schoolId, studentId } = parseStudentOwnerId(owner.ownerId);
  const sc = schoolId ? await getSchool(schoolId) : null;
  const student = sc ? (sc.students || []).find(s => s.id === studentId) : null;
  return { authorType: 'student', authorName: student?.name || '학생', ownerId: owner.ownerId };
}
```

`action === 'mine'` 블록 위, 즉 `export default async function handler(req, res) { const { action } = req.query;` 바로 다음에 공개 조회 액션을 추가한다:

```js
  // 후기 게시판 — 비로그인 방문자도 조회 가능(마케팅 사이트 신뢰도 목적).
  if (action === 'review-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const reviews = await listReviewsForPublic();
    return res.status(200).json({ success: true, reviews });
  }
```

기존 `action === 'apply'` 블록 다음(즉 `create-payment` 블록 앞이나 뒤 아무 곳이나, `const admin = await requireAdminSessionOrApiToken(req);` 줄보다는 반드시 위)에 다음 세 액션을 추가한다:

```js
  // 후기 작성 — 관리자(선생님) 또는 학생 로그인 필요. 승인 절차 없이 즉시 공개되므로
  // 스팸 방지 목적으로 비로그인 작성은 막는다(설계 문서 "안전장치" 참고).
  if (action === 'review-create') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const admin = await requireAdminSessionOrApiToken(req);
    const author = await requireReviewAuthor(req, admin);
    if (!author) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { text, images } = req.body || {};
    try {
      const review = await createReview({ ...author, text, images });
      return res.status(200).json({ success: true, review });
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message || '후기 작성에 실패했습니다' });
    }
  }

  // 후기 이미지 업로드 — 후기 작성 폼에서 이미지를 고르면 먼저 이 액션으로 하나씩 올려
  // URL을 받고, 그 URL들을 모아 review-create를 호출한다.
  if (action === 'review-image-upload') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const admin = await requireAdminSessionOrApiToken(req);
    const author = await requireReviewAuthor(req, admin);
    if (!author) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { filename, mimeType, dataBase64 } = req.body || {};
    if (!dataBase64) return res.status(400).json({ success: false, message: 'Missing dataBase64' });
    try {
      const url = await uploadReviewImage(dataBase64, filename, mimeType);
      return res.status(200).json({ success: true, url });
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message || '이미지 업로드에 실패했습니다' });
    }
  }

  // 댓글 작성 — 후기 작성과 동일한 주체(선생님/학생)만 가능.
  if (action === 'comment-create') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const admin = await requireAdminSessionOrApiToken(req);
    const author = await requireReviewAuthor(req, admin);
    if (!author) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { reviewId, text } = req.body || {};
    if (!reviewId) return res.status(400).json({ success: false, message: 'Missing reviewId' });
    try {
      const comment = await addComment(reviewId, { ...author, text });
      return res.status(200).json({ success: true, comment });
    } catch (e) {
      const status = e.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ success: false, message: e.message || '댓글 작성에 실패했습니다' });
    }
  }
```

마지막으로, 기존 `const admin = await requireAdminSessionOrApiToken(req);` 게이트 이후(관리자 전용 액션들 사이, 예: `admin-list` 블록 근처)에 삭제 액션 두 개를 추가한다:

```js
  // 승인 절차 없이 즉시 공개되는 게시판이므로, 스팸/부적절한 글은 관리자가 사후 삭제한다.
  if (action === 'review-delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
    await deleteReview(id);
    return res.status(200).json({ success: true });
  }

  if (action === 'comment-delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { reviewId, commentId } = req.body || {};
    if (!reviewId || !commentId) return res.status(400).json({ success: false, message: 'Missing reviewId/commentId' });
    await deleteComment(reviewId, commentId);
    return res.status(200).json({ success: true });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test tests/review.test.mjs`
Expected: PASS (5 tests)

Run also: `npm test` (전체 회귀 — 기존 course/watch/dropbox/review-lib 테스트가 모두 여전히 통과하는지 확인)
Expected: PASS, 0 failing

- [ ] **Step 5: Commit**

```bash
git add api/courses/\[action\].js tests/review.test.mjs
git commit -m "$(cat <<'EOF'
후기/댓글 API 액션을 courses 라우트에 추가 (Vercel 12개 함수 한도 유지)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `lecture.html` — 공개 후기 게시판 화면

**Files:**
- Modify: `lecture.html`

**Interfaces:**
- Consumes: `GET /api/courses/review-list`, `POST /api/courses/review-image-upload`, `POST /api/courses/review-create`, `POST /api/courses/comment-create` (Task 3), 기존 `ST`/`esc`/`render`/`navBar`/`goStart`/`doLogout` 등
- Produces: `ST.screen==='reviews'` 화면, `ST.reviews` 상태

- [ ] **Step 1: CSS 추가**

`.review-grid{...}` 규칙(기존 117번째 줄 근처) 바로 다음에 추가:

```css
  .rcard-post{text-align:left}
  .rcard-author{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px}
  .rcard-author .badge{background:#FFE4DC;color:var(--coral-dark);font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px}
  .rcard-author .who{color:var(--navy-soft);font-size:11.5px;margin-left:auto}
  .rcard-images{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
  .rcard-images img{width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid var(--border)}
  .rcard-comments{margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
  .rcard-comment{font-size:12.5px;margin-bottom:6px;line-height:1.5}
  .rcard-comment .badge{background:var(--lightbg);color:var(--navy-soft);font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:20px;margin-right:4px}
  .rcard-comment-form{display:flex;gap:8px;margin-top:8px}
  .rcard-comment-form .finp{flex:1;margin:0}
  .review-write-form{border:1px solid var(--border);border-radius:14px;padding:18px;margin-top:0;margin-bottom:20px;background:#fff}
  .review-write-form textarea.finp{resize:vertical}
  .review-login-cta{text-align:center;margin-bottom:20px}
  .navlinks button:hover{color:var(--coral)}
```

`.navlinks a:hover{color:var(--coral)}` 규칙(26번째 줄 근처)은 `<a>`만 대상으로 하므로, Step 2에서 "실제 후기"를 `<button>`으로 바꾸면 이 한 줄이 없으면 호버 색상이 빠진다 — 위 CSS에 포함해 함께 추가한다.

- [ ] **Step 2: 네비게이션을 앵커에서 화면 전환 버튼으로 변경**

392번째 줄 근처 `navBar()`의 `links` 정의를 바꾼다:

```js
  const links=showLanding
    ?`<div class="navlinks"><a href="#courses">강좌</a><a href="#instructor">선생님 소개</a><a href="#features">커리큘럼</a><button class="nav-textlink" id="nav-reviews-link" style="background:none;border:none;font:inherit;cursor:pointer;padding:0;color:inherit">실제 후기</button></div>`
    :'';
```

- [ ] **Step 3: 기존 인라인 후기 섹션에 "더보기" 버튼 추가**

548번째 줄 근처 `<section class="section" id="reviews">` 안, `</div>`(review-grid 닫는 태그) 바로 다음에 추가:

```html
        <div style="text-align:center;margin-top:24px">
          <button class="btn" id="btn-reviews-more">더 많은 후기 보기 →</button>
        </div>
```

- [ ] **Step 4: 후기 게시판 화면 함수 추가**

`playerScreen()`/`watchStatusHtml`/`loadAndRenderWatchStatus` 함수들(656~700번째 줄 근처) 다음, `function render(){` 정의 이전에 추가:

```js
async function loadReviews(){
  try{
    const res=await fetch('/api/courses/review-list');
    const d=await res.json();
    return d.success?d.reviews:[];
  }catch(e){return [];}
}

function reviewImagesHtml(images){
  if(!images||!images.length)return'';
  return`<div class="rcard-images">${images.map(u=>`<img src="${esc(u)}" alt="후기 이미지" loading="lazy">`).join('')}</div>`;
}

function reviewCommentsHtml(review){
  const comments=review.comments||[];
  const list=comments.map(c=>`<div class="rcard-comment"><span class="badge">${c.authorType==='teacher'?'선생님':'학생'}</span><b>${esc(c.authorName)}</b> ${esc(c.text)}</div>`).join('');
  const canWrite=ST.mode==='student';
  const form=canWrite
    ?`<div class="rcard-comment-form"><input class="finp" data-comment-input="${review.id}" placeholder="댓글을 입력하세요" maxlength="2000"><button class="btn" data-comment-submit="${review.id}">등록</button></div>`
    :'';
  return`<div class="rcard-comments">${list}${form}</div>`;
}

function reviewCardHtml(r){
  return`<div class="rcard rcard-post">
    <div class="rcard-author"><span class="badge">${r.authorType==='teacher'?'👩‍🏫 선생님':'🙋 학생'}</span><b>${esc(r.authorName)}</b><span class="who">${esc((r.createdAt||'').slice(0,10))}</span></div>
    <div class="body">${esc(r.text)}</div>
    ${reviewImagesHtml(r.images)}
    ${reviewCommentsHtml(r)}
  </div>`;
}

function reviewWriteFormHtml(){
  if(ST.mode!=='student')return`<div class="review-login-cta"><button class="btn btn-primary" id="btn-review-login">로그인하고 후기 남기기</button></div>`;
  return`<div class="review-write-form">
    <textarea class="finp" id="review-text" rows="4" maxlength="2000" placeholder="후기를 남겨주세요"></textarea>
    <input type="file" id="review-images" accept="image/*" multiple>
    <div id="review-write-msg" style="font-size:12px;margin-top:6px"></div>
    <button class="btn btn-primary" id="btn-review-submit">후기 등록</button>
  </div>`;
}

function reviewsScreen(){
  const reviews=ST.reviews||[];
  const grid=reviews.length
    ?`<div class="review-grid">${reviews.map(reviewCardHtml).join('')}</div>`
    :`<div class="empty"><div class="ic">💬</div><div style="font-size:14px;font-weight:600;color:var(--navy);margin-bottom:6px">아직 등록된 후기가 없습니다</div></div>`;
  return`<button class="player-back" id="btn-reviews-back">‹ 처음으로</button>
    <div class="player-title">실제 후기</div>
    ${reviewWriteFormHtml()}
    ${grid}`;
}

function readFileAsBase64(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>{
      const result=reader.result;
      const comma=result.indexOf(',');
      resolve(comma>=0?result.slice(comma+1):result);
    };
    reader.onerror=reject;
    reader.readAsDataURL(file);
  });
}

async function submitReview(){
  const btn=document.getElementById('btn-review-submit');
  const msg=document.getElementById('review-write-msg');
  const text=document.getElementById('review-text').value.trim();
  const files=[...(document.getElementById('review-images').files||[])].slice(0,6);
  if(!text){msg.textContent='후기 내용을 입력하세요';msg.style.color='#E53935';return;}
  btn.disabled=true;msg.textContent='등록 중...';msg.style.color='';
  try{
    const images=[];
    for(const file of files){
      const dataBase64=await readFileAsBase64(file);
      const res=await fetch('/api/courses/review-image-upload',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:file.name,mimeType:file.type,dataBase64})});
      const d=await res.json();
      if(!d.success){msg.textContent=d.message||'이미지 업로드 실패';msg.style.color='#E53935';btn.disabled=false;return;}
      images.push(d.url);
    }
    const createRes=await fetch('/api/courses/review-create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,images})});
    const createData=await createRes.json();
    if(!createData.success){msg.textContent=createData.message||'후기 등록 실패';msg.style.color='#E53935';btn.disabled=false;return;}
    ST.reviews=await loadReviews();render();
  }catch(e){
    msg.textContent='오류가 발생했습니다';msg.style.color='#E53935';btn.disabled=false;
  }
}

async function submitComment(reviewId){
  const input=document.querySelector(`[data-comment-input="${reviewId}"]`);
  const text=input.value.trim();
  if(!text)return;
  try{
    const res=await fetch('/api/courses/comment-create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({reviewId,text})});
    const d=await res.json();
    if(d.success){ST.reviews=await loadReviews();render();}
    else alert(d.message||'댓글 등록에 실패했습니다');
  }catch(e){alert('오류가 발생했습니다');}
}

function wireReviews(){
  document.getElementById('nav-logo')?.addEventListener('click',()=>{window.scrollTo({top:0,behavior:'smooth'});});
  document.getElementById('btn-logout')?.addEventListener('click',doLogout);
  document.getElementById('nav-browse-courses')?.addEventListener('click',async()=>{ST.courses=await loadPublicCourses();ST.screen='browse';render();});
  document.getElementById('btn-reviews-back').addEventListener('click',()=>{ST.screen='browse';render();});
  document.getElementById('btn-review-login')?.addEventListener('click',goStart);
  document.getElementById('btn-review-submit')?.addEventListener('click',submitReview);
  document.querySelectorAll('[data-comment-submit]').forEach(btn=>{
    btn.addEventListener('click',()=>submitComment(btn.dataset.commentSubmit));
  });
}
```

- [ ] **Step 5: `render()`에 화면 분기 추가**

`function render(){` 안, `if(ST.screen==='browse'){...}` 다음 줄에 추가:

```js
  if(ST.screen==='reviews'){app.innerHTML=navBar()+`<main><div class="app-main">${reviewsScreen()}</div></main>`;wireReviews();return;}
```

- [ ] **Step 6: 네비/더보기 버튼 클릭 연결**

`wireBrowse()` 함수 안, `document.getElementById('nav-browse-courses')?.addEventListener(...)` 다음 줄에 추가:

```js
  document.getElementById('nav-reviews-link')?.addEventListener('click',async()=>{ST.reviews=await loadReviews();ST.screen='reviews';render();});
  document.getElementById('btn-reviews-more')?.addEventListener('click',async()=>{ST.reviews=await loadReviews();ST.screen='reviews';render();});
```

- [ ] **Step 7: 수동 확인**

```bash
node -e "const fs=require('fs');const html=fs.readFileSync('lecture.html','utf8');const m=html.match(/<script>([\s\S]*)<\/script>/);new Function(m[1]);console.log('OK: syntax valid')"
```
Expected: `OK: syntax valid`

로컬 dev 서버(`vercel dev` 또는 기존에 쓰던 방식)로 `lecture.html`을 열어:
1. 랜딩 페이지 "실제 후기" 클릭 → 별도 화면으로 이동하는지, 기존 3개 정적 후기 섹션 아래 "더 많은 후기 보기" 버튼도 같은 화면으로 가는지 확인
2. 비로그인 상태에서 "로그인하고 후기 남기기" 버튼만 보이고 작성 폼은 없는지 확인
3. 학생 계정으로 로그인 후 텍스트+이미지 1~2장으로 후기 작성 → 목록에 즉시 반영되는지, 이미지가 실제로 보이는지(드롭박스 URL) 확인
4. 같은 후기에 댓글 작성 → 반영 확인
5. 브라우저 개발자도구 Network 탭에서 `review-list` 응답에 `ownerId` 필드가 없는지 확인

- [ ] **Step 8: Commit**

```bash
git add lecture.html
git commit -m "$(cat <<'EOF'
lecture.html에 공개 후기 게시판 화면 추가 (이미지+텍스트, 학생 작성/댓글)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `index.html` — 관리자(선생님) 후기 작성/삭제 화면

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `GET /api/courses/review-list`, `POST /api/courses/review-image-upload`, `POST /api/courses/review-create`, `POST /api/courses/review-delete`, `POST /api/courses/comment-delete` (Task 3), 기존 `ST`/`esc`/`render`/`doLogout`
- Produces: `ST.adminView==='reviews'` 화면

- [ ] **Step 1: 네비 버튼 추가**

1939번째 줄:
```html
<div class="nav-right"><button class="nbtn" id="btn-goto-account">⚙️ 계정 관리</button><button class="nbtn" id="btn-goto-courses">🎓 강좌 관리</button><button class="nbtn" id="btn-alo-main">로그아웃</button></div>
```
을 다음으로 교체:
```html
<div class="nav-right"><button class="nbtn" id="btn-goto-account">⚙️ 계정 관리</button><button class="nbtn" id="btn-goto-courses">🎓 강좌 관리</button><button class="nbtn" id="btn-goto-reviews">💬 후기 관리</button><button class="nbtn" id="btn-alo-main">로그아웃</button></div>
```

- [ ] **Step 2: `render()` 분기 추가**

1411~1420번째 줄의 `render()`에서, `if(ST.adminView==='courses'){app.innerHTML=rCourseAdmin();bCourseAdmin();return;}` 다음 줄에 추가:

```js
    if(ST.adminView==='reviews'){app.innerHTML=rReviewAdmin();bReviewAdmin();return;}
```

- [ ] **Step 3: 버튼 클릭 연결**

2079번째 줄 `document.getElementById('btn-goto-courses').onclick=()=>{ST.adminView='courses';render();};` 다음 줄에 추가:

```js
  document.getElementById('btn-goto-reviews').onclick=()=>{ST.adminView='reviews';render();};
```

- [ ] **Step 4: 관리자 후기 화면 함수 추가**

`bCourseAdmin(){...}` 함수(2366~2417번째 줄) 바로 다음에 추가:

```js
function reviewImagesAdminHtml(images){
  if(!images||!images.length)return'';
  return`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${images.map(u=>`<img src="${esc(u)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #E8ECF0">`).join('')}</div>`;
}

function rReviewAdmin(){
  return`
  <div class="top-nav">
    <div class="nav-logo"><img src="/assets/logo-symbol-white.png" alt="OHENG" style="height:22px;width:auto;display:block"></div>
    <div class="nav-right"><button class="nbtn" id="btn-back-schools-rv">‹ 학교 선택으로</button><button class="nbtn" id="btn-alo-main-rv">로그아웃</button></div>
  </div>
  <div class="school-wrap">
    <div class="school-inner" style="max-width:760px">
      <div style="text-align:center;margin-bottom:32px">
        <div style="width:60px;height:60px;border-radius:18px;background:#FF6B4A;display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 14px;box-shadow:0 8px 24px rgba(255,107,74,0.28)">💬</div>
        <div class="school-title" style="color:#12151C">후기 관리</div>
        <div class="school-sub">oheng.co.kr 후기 게시판 — 선생님 후기 작성, 부적절한 게시물 삭제</div>
      </div>
      <div style="border:1.5px solid #E8ECF0;border-radius:12px;padding:16px;margin-bottom:20px">
        <div style="font-weight:700;font-size:13px;margin-bottom:8px">선생님 후기 작성</div>
        <textarea id="rv-text" rows="4" maxlength="2000" placeholder="후기 내용을 입력하세요" style="width:100%;padding:10px 12px;border:1.5px solid #E8ECF0;border-radius:8px;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>
        <input type="file" id="rv-images" accept="image/*" multiple style="margin-top:8px">
        <div id="rv-write-msg" style="font-size:12px;margin-top:6px"></div>
        <button class="abtn abtn-green" id="btn-rv-submit" style="margin-top:8px">후기 등록</button>
      </div>
      <div id="review-admin-list-wrap"></div>
    </div>
  </div>`;
}

async function renderReviewAdminList(){
  const wrap=document.getElementById('review-admin-list-wrap');
  if(!wrap)return;
  wrap.innerHTML='<div style="text-align:center;padding:30px 0;color:#9BA3AF;font-size:13px">불러오는 중...</div>';
  let reviews=[];
  try{
    const res=await fetch('/api/courses/review-list');
    const data=await res.json();
    reviews=data.success?data.reviews:[];
  }catch(e){}
  if(!reviews.length){wrap.innerHTML='<div style="text-align:center;padding:40px 0;color:#9BA3AF;font-size:13px">등록된 후기가 없습니다</div>';return;}
  wrap.innerHTML=reviews.map(r=>`
    <div class="school-card" style="text-align:left;cursor:default;padding:16px 18px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div>
          <div style="font-size:12px;color:#5C6470"><b>${r.authorType==='teacher'?'👩‍🏫 선생님':'🙋 학생'}</b> ${esc(r.authorName)} · ${esc((r.createdAt||'').slice(0,10))}</div>
          <div style="font-size:13.5px;margin-top:6px;white-space:pre-wrap">${esc(r.text)}</div>
          ${reviewImagesAdminHtml(r.images)}
        </div>
        <button class="abtn abtn-red" data-del-review="${r.id}" style="font-size:11px;padding:6px 10px;flex-shrink:0">🗑️ 삭제</button>
      </div>
      ${(r.comments||[]).length?`<div style="margin-top:12px;padding-top:12px;border-top:1px solid #F0F2F5">${r.comments.map(c=>`
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;padding:4px 0">
          <span>${c.authorType==='teacher'?'👩‍🏫':'🙋'} <b>${esc(c.authorName)}</b> ${esc(c.text)}</span>
          <button class="abtn abtn-red" data-del-comment="${c.id}" data-del-comment-review="${r.id}" style="font-size:10px;padding:3px 8px;flex-shrink:0">삭제</button>
        </div>`).join('')}</div>`:''}
    </div>`).join('');
  wrap.querySelectorAll('[data-del-review]').forEach(b=>{
    b.onclick=async()=>{
      if(!confirm('이 후기를 삭제할까요? 되돌릴 수 없습니다.'))return;
      b.disabled=true;
      try{
        await fetch('/api/courses/review-delete',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset.delReview})});
      }catch(e){}
      renderReviewAdminList();
    };
  });
  wrap.querySelectorAll('[data-del-comment]').forEach(b=>{
    b.onclick=async()=>{
      if(!confirm('이 댓글을 삭제할까요?'))return;
      b.disabled=true;
      try{
        await fetch('/api/courses/comment-delete',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({reviewId:b.dataset.delCommentReview,commentId:b.dataset.delComment})});
      }catch(e){}
      renderReviewAdminList();
    };
  });
}

function readFileAsBase64Admin(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>{
      const result=reader.result;
      const comma=result.indexOf(',');
      resolve(comma>=0?result.slice(comma+1):result);
    };
    reader.onerror=reject;
    reader.readAsDataURL(file);
  });
}

function bReviewAdmin(){
  document.getElementById('btn-alo-main-rv').onclick=doLogout;
  document.getElementById('btn-back-schools-rv').onclick=()=>{ST.adminView=null;render();};
  document.getElementById('btn-rv-submit').onclick=async()=>{
    const btn=document.getElementById('btn-rv-submit');
    const msg=document.getElementById('rv-write-msg');
    const text=document.getElementById('rv-text').value.trim();
    const files=[...(document.getElementById('rv-images').files||[])].slice(0,6);
    if(!text){msg.textContent='후기 내용을 입력하세요';msg.style.color='#E53935';return;}
    btn.disabled=true;msg.textContent='등록 중...';msg.style.color='';
    try{
      const images=[];
      for(const file of files){
        const dataBase64=await readFileAsBase64Admin(file);
        const res=await fetch('/api/courses/review-image-upload',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:file.name,mimeType:file.type,dataBase64})});
        const d=await res.json();
        if(!d.success){msg.textContent=d.message||'이미지 업로드 실패';msg.style.color='#E53935';btn.disabled=false;return;}
        images.push(d.url);
      }
      const createRes=await fetch('/api/courses/review-create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,images})});
      const createData=await createRes.json();
      if(!createData.success){msg.textContent=createData.message||'후기 등록 실패';msg.style.color='#E53935';btn.disabled=false;return;}
      document.getElementById('rv-text').value='';
      document.getElementById('rv-images').value='';
      msg.textContent='등록되었습니다';msg.style.color='#00897B';btn.disabled=false;
      renderReviewAdminList();
    }catch(e){
      msg.textContent='오류가 발생했습니다';msg.style.color='#E53935';btn.disabled=false;
    }
  };
  renderReviewAdminList();
}
```

- [ ] **Step 5: 수동 확인**

```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const m=html.match(/<script>([\s\S]*)<\/script>/);new Function(m[1]);console.log('OK: syntax valid')"
```
Expected: `OK: syntax valid`

관리자로 로그인 후:
1. 상단 네비 "💬 후기 관리" 클릭 → 화면 진입 확인
2. 텍스트+이미지로 후기 작성 → 목록에 즉시 반영, `authorType`이 선생님으로 표시되는지 확인
3. `lecture.html`을 새로고침해 방금 올린 선생님 후기가 공개 화면에도 보이는지 확인
4. 학생 계정으로 `lecture.html`에서 후기/댓글을 하나 남긴 뒤, 관리자 화면에서 삭제 버튼으로 지워지는지 확인

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
index.html에 관리자(선생님) 후기 작성/삭제 화면 추가

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 배포 및 실서비스 확인

**Files:** 없음(배포/설정 작업)

- [ ] **Step 1: 전체 테스트 재확인**

```bash
npm test
```
Expected: PASS, 0 failing (기존 course/watch 테스트 + 이번에 추가한 dropbox/review-lib/review 테스트 모두 통과)

- [ ] **Step 2: 남아있던 오은실 "대표강사" 수정도 함께 배포 (이전 세션에서 로컬 수정만 되어있던 상태)**

```bash
git status --short lecture.html
```
`review` 관련 커밋에 이미 포함되어 있다면 이 단계는 생략. 별도로 남아있다면:
```bash
git add lecture.html
git commit -m "$(cat <<'EOF'
오은실 호칭을 원장에서 대표강사로 정정

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: 사용자에게 드롭박스 환경변수 등록 요청**

아래 3개를 Vercel 대시보드(Production + Preview)에 등록해달라고 사용자에게 요청한다 — 값은 이 세션에서 절대 요청하거나 대화에 남기지 않는다:
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

(드롭박스 앱 콘솔에서 "Generate access token" 대신 OAuth2 refresh token 방식으로 발급받아야 만료 없이 쓸 수 있다는 점을 안내한다.)

- [ ] **Step 4: 배포**

```bash
git push
```
Vercel 자동 배포 확인 후, 배포된 `oheng.co.kr`/`oheng.vercel.app`에서 Task 4/Task 5의 수동 확인 체크리스트를 다시 한 번 프로덕션 환경에서 반복한다(드롭박스 환경변수가 실제로 등록된 이후에만 이미지 업로드가 성공함 — 텍스트만으로는 환경변수 없이도 확인 가능).

---

## 구현 완료 상태 (2026-09-09)

Task 1~6 전부 구현 완료, subagent-driven-development로 진행 — 태스크별 구현→리뷰, 최종 전체 리뷰 1회(8개 지적사항 일괄 수정 후 재검증 통과). 로컬 `main`에 아래 커밋들로 이미 존재함(별도 브랜치 없이 직접 커밋, 사용자 동의):

```
501acb5a (이 계획 커밋 직전 지점, BASE)
31712c0  후기 이미지용 드롭박스 업로드 모듈 추가
6abafdc  후기/댓글 Redis 데이터 계층 추가
ada5044  후기/댓글 API 액션을 courses 라우트에 추가
1da05be  lecture.html에 공개 후기 게시판 화면 추가
35e48db  index.html에 관리자(선생님) 후기 작성/삭제 화면 추가
85d780d  관리자 후기 삭제 버튼에 실패 시 알림 표시
e2e2d16  최종 리뷰 지적사항 일괄 수정 (로그인 CTA, 이미지 3MB 제한, URL 화이트리스트, 선생님 댓글 UI 등)
1fe064c  주석 오타 수정 (최신 HEAD)
```

`npm test` 52/52 통과.

### 배포 완료 (2026-09-10)

`git push` → Vercel 프로덕션 배포 `dpl_BunsvXXFB1FvpoKLGys8tn6SE4PV` (커밋 3efcb8e) READY, 함수 12개(한도 내). 실제 `oheng.co.kr`에서 Playwright로 검증: 데스크톱/모바일(390px) 모두 "실제 후기" 진입 → 빈 상태 + 비로그인 시 "로그인하고 후기 남기기"만 표시(작성 폼 없음) → "‹ 처음으로" 복귀 정상. 쓰기 API(`review-create`/`review-image-upload`/`review-delete`)는 비로그인 401 확인.

**라우팅 주의(검증 중 헛돈 원인):** `oheng.co.kr/` → `lecture.html`은 `index.html` 최상단의 **클라이언트 JS 리다이렉트**(`location.replace`)다. Vercel 파일시스템 라우팅이 루트의 실제 `index.html`을 먼저 서빙해 서버 rewrite로는 가로챌 수 없어 의도적으로 이렇게 만든 것(커밋 f9ea26a). 따라서 `curl https://oheng.co.kr/`은 index.html 바이트를 돌려주며 **정상**이다 — 공개 사이트 확인은 반드시 실제 브라우저로. 모바일(<860px)에선 상단 네비 링크가 숨겨지므로 후기 게시판 진입점은 랜딩 하단 "더 많은 후기 보기 →" 버튼이다.

### 남은 일 (다음 세션/Codex가 이어받을 것)

1. **Vercel에 드롭박스 시크릿 미등록** — `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` (Production+Preview). 사용자가 Vercel 대시보드에서 직접 등록해야 함(OAuth2 refresh token 방식 — 만료 없음). 미등록 상태에서도 텍스트만 있는 후기는 정상 동작하고, 이미지 업로드만 실패함.
2. **로그인이 필요한 수동 확인은 아직 안 됨**: 비로그인 조회 경로는 위에서 검증 완료. 학생 계정으로 후기 작성(이미지 첨부·댓글), 관리자 계정으로 후기 작성/삭제/댓글은 실제 로그인과 드롭박스 시크릿이 필요해 미확인 — 시크릿 등록 후 사용자가 직접 한 번 확인할 것.
3. **미해결로 남겨둔 항목(최종 리뷰에서 나왔지만 의도적으로 이번 범위에서 제외, 우선순위 낮음)**:
   - `review:index`/`review:comments:{id}` 동시 쓰기 경쟁 상태 — `api/_lib/auth.js`의 `CAS_SET_SCRIPT` 패턴 재사용 가능(트래픽 커지면).
   - `review-list` 페이지네이션/요청 제한 없음 — `api/_lib/auth.js`의 `checkRateLimit` 재사용 가능.
   - 업로드 실패 시 UX 디테일(파일 입력 초기화 안 됨 등), 댓글 등록 시 화면 전체 재렌더링(다른 카드 임시 입력값 사라짐), 탈퇴 학생 엣지 케이스, `.review-grid` 2열 레이아웃이 좁음 — 전부 사소한 폴리시.
   - `#E53935` vs lecture.html 자체 `.login-err{color:#E0473E}` 색상 불일치 — 인지 불가 수준(ΔE≈2), 방치해도 무방.

### Codex 등 다른 도구에서 이어받을 때

이 저장소는 전부 git에 커밋돼 있으므로 대화 기록 없이도 아래만 읽으면 전체 맥락 파악 가능:
- 스펙: `docs/superpowers/specs/2026-09-09-reviews-board-design.md`
- 이 계획 문서(현재 파일) 전체, 특히 이 섹션
- `git log --oneline 501acb5a..HEAD` (또는 `git show <hash>`로 각 커밋 diff)
