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

test('일반 회원(member) 세션은 review-create/comment-create에서 401 (학생으로 취급되면 안 됨)', async () => {
  const memberId = 'mem_rv_reject';
  await fakeRedis.set('member:' + memberId, { id: memberId, name: '일반회원', phone: '01099998888', entitlements: [] });
  const { token } = await auth.createSession({ role: 'member', memberId });

  const resCreate = makeRes();
  await courseHandler(
    { method: 'POST', headers: { cookie: `oheng_session=${token}` }, body: { text: '회원인데 몰래 작성' }, query: { action: 'review-create' } },
    resCreate
  );
  assert.equal(resCreate.statusCode, 401);

  const resComment = makeRes();
  await courseHandler(
    { method: 'POST', headers: { cookie: `oheng_session=${token}` }, body: { reviewId: 'x', text: '회원인데 몰래 댓글' }, query: { action: 'comment-create' } },
    resComment
  );
  assert.equal(resComment.statusCode, 401);
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
