import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) { const existed = store.has(key); store.delete(key); return existed ? 1 : 0; },
    async incr(key) { const v = (store.get(key) || 0) + 1; store.set(key, v); return v; },
    async expire() { return 1; },
  };
}
function makeRes() {
  const res = { statusCode: 200, body: undefined, headers: {},
    status(c) { res.statusCode = c; return res; }, json(o) { res.body = o; return res; }, end() { return res; }, setHeader(k, v) { res.headers[k] = v; } };
  return res;
}
const fakeRedis = makeFakeRedis();
process.env.API_AUTH_TOKEN = 'test-admin-token';
before(() => {
  mock.module('../api/_lib/redis.js', { namedExports: { getRedis: () => fakeRedis } });
  mock.module('../api/_lib/dropbox.js', { namedExports: {
    getTemporaryLink: async () => 'https://dl.dropboxusercontent.com/x', listVideoFolder: async () => ({ files: [], folderMissing: false }),
    uploadReviewImage: async () => '', REVIEW_IMAGE_LIMITS: { MAX_IMAGE_BYTES: 0, MAX_IMAGES_PER_REVIEW: 0 } } });
});
const auth = await import('../api/_lib/auth.js');
const video = await import('../api/_lib/video.js');
const handler = (await import('../api/videos/[action].js')).default;

const SCHOOL = 'sch_wa';
async function seedSchool() {
  await fakeRedis.set('school:' + SCHOOL, { id: SCHOOL, name: '시청테스트고', version: 0,
    students: [{ id: 'stu_a', name: '가나다', entitlements: [] }, { id: 'stu_b', name: '라마바', entitlements: [] }], withdrawnStudents: [] });
}
async function studentCookie(sid) { const { token } = await auth.createSession({ role: 'student', schoolId: SCHOOL, studentId: sid }); return `oheng_session=${token}`; }
const ADMIN = { 'x-api-token': 'test-admin-token' };

test('watch-progress: 비로그인 401, 안 보이는 영상 404, 잘못된 입력 400, 정상 200 + progress', async () => {
  await seedSchool();
  await video.saveVideo({ id: 'wv1', title: '1주 해설', month: '9월', week: '1주', dropboxPath: '/videos/a.mp4', allowSchoolIds: [SCHOOL] });
  await video.saveVideo({ id: 'wv-other', title: '남의 영상', dropboxPath: '/videos/b.mp4', allowSchoolIds: ['other'] });
  const cookie = await studentCookie('stu_a');
  const good = { videoId: 'wv1', durationSec: 100, segments: [[0, 95]], lastPositionSec: 95 };

  const anon = makeRes();
  await handler({ method: 'POST', headers: {}, body: good, query: { action: 'watch-progress' } }, anon);
  assert.equal(anon.statusCode, 401);

  const hidden = makeRes();
  await handler({ method: 'POST', headers: { cookie }, body: { ...good, videoId: 'wv-other' }, query: { action: 'watch-progress' } }, hidden);
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.body.message, '볼 수 없는 영상입니다');

  const bad = makeRes();
  await handler({ method: 'POST', headers: { cookie }, body: { ...good, durationSec: 0 }, query: { action: 'watch-progress' } }, bad);
  assert.equal(bad.statusCode, 400);

  const ok = makeRes();
  await handler({ method: 'POST', headers: { cookie }, body: good, query: { action: 'watch-progress' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.record.status, 'auto_completed');
  assert.equal(ok.body.record.progress.ratio, 0.95);

  const mine = makeRes();
  await handler({ method: 'GET', headers: { cookie }, query: { action: 'watch-mine', videoIds: 'wv1' } }, mine);
  assert.equal(mine.body.statuses.wv1.progress.watchedSec, 95);
});

test('watch-admin-week: 주차별로 학생×영상 완료 수를 집계하고, 학생 예외로 차단된 영상은 세지 않는다', async () => {
  await seedSchool();
  await video.saveVideo({ id: 'wk1', title: '9월 2주 A', month: '9월', week: '2주', dropboxPath: '/videos/c.mp4', allowSchoolIds: [SCHOOL] });
  await video.saveVideo({ id: 'wk2', title: '9월 2주 B', month: '9월', week: '2주', dropboxPath: '/videos/d.mp4', allowSchoolIds: [SCHOOL], excludeStudentIds: ['stu_b'] });
  const cookieA = await studentCookie('stu_a');
  await handler({ method: 'POST', headers: { cookie: cookieA }, body: { videoId: 'wk1', durationSec: 100, segments: [[0, 100]] }, query: { action: 'watch-progress' } }, makeRes());
  await handler({ method: 'POST', headers: { cookie: cookieA }, body: { videoId: 'wk2', durationSec: 100, segments: [[0, 30]] }, query: { action: 'watch-progress' } }, makeRes());

  const anon = makeRes();
  await handler({ method: 'GET', headers: {}, query: { action: 'watch-admin-week', schoolId: SCHOOL, month: '9월' } }, anon);
  assert.equal(anon.statusCode, 401);

  const res = makeRes();
  await handler({ method: 'GET', headers: ADMIN, query: { action: 'watch-admin-week', schoolId: SCHOOL, month: '9월', week: '2주' } }, res);
  assert.equal(res.statusCode, 200);
  const w = res.body.weeks['2주'];
  assert.deepEqual(w.videos.map(v => v.id).sort(), ['wk1', 'wk2']);
  assert.equal(w.students.stu_a.completed, 1);
  assert.equal(w.students.stu_a.total, 2);
  assert.equal(w.students.stu_a.best.videoId, 'wk1');
  assert.equal(w.students.stu_b.total, 1, '예외로 차단된 wk2는 stu_b에게 세지 않음');
  assert.equal(w.students.stu_b.completed, 0);
  assert.equal(w.students.stu_b.best, null);

  const all = makeRes();
  await handler({ method: 'GET', headers: ADMIN, query: { action: 'watch-admin-week', schoolId: SCHOOL, month: '9월' } }, all);
  assert.ok(all.body.weeks['1주'] && all.body.weeks['2주'], 'week 생략 시 그 달의 모든 주차');
});

test('watch-admin-week: exempt 처리된 영상은 total에서 빠지고 completed/best에 들어가지 않는다', async () => {
  await seedSchool();
  await video.saveVideo({ id: 'ex1', title: '9월 3주 A', month: '9월', week: '3주', dropboxPath: '/videos/e1.mp4', allowSchoolIds: [SCHOOL] });
  await video.saveVideo({ id: 'ex2', title: '9월 3주 B', month: '9월', week: '3주', dropboxPath: '/videos/e2.mp4', allowSchoolIds: [SCHOOL] });
  const cookieA = await studentCookie('stu_a');
  await handler({ method: 'POST', headers: { cookie: cookieA }, body: { videoId: 'ex1', durationSec: 100, segments: [[0, 100]] }, query: { action: 'watch-progress' } }, makeRes());
  await handler({ method: 'POST', headers: ADMIN, body: { schoolId: SCHOOL, studentId: 'stu_a', videoId: 'ex2', status: 'exempt' }, query: { action: 'watch-admin-set' } }, makeRes());

  const res = makeRes();
  await handler({ method: 'GET', headers: ADMIN, query: { action: 'watch-admin-week', schoolId: SCHOOL, month: '9월', week: '3주' } }, res);
  const w = res.body.weeks['3주'];
  assert.equal(w.students.stu_a.completed, 1);
  assert.equal(w.students.stu_a.total, 1);
  assert.equal(w.students.stu_a.exempt, 1);
  assert.equal(w.students.stu_a.best.status, 'auto_completed');
});

test('watch-admin-week: 대상 영상이 모두 exempt면 total 0·completed 0·best null', async () => {
  await seedSchool();
  await video.saveVideo({ id: 'ex3', title: '9월 4주 A', month: '9월', week: '4주', dropboxPath: '/videos/e3.mp4', allowSchoolIds: [SCHOOL] });
  await handler({ method: 'POST', headers: ADMIN, body: { schoolId: SCHOOL, studentId: 'stu_a', videoId: 'ex3', status: 'exempt' }, query: { action: 'watch-admin-set' } }, makeRes());
  const res = makeRes();
  await handler({ method: 'GET', headers: ADMIN, query: { action: 'watch-admin-week', schoolId: SCHOOL, month: '9월', week: '4주' } }, res);
  const w = res.body.weeks['4주'];
  assert.equal(w.students.stu_a.completed, 0);
  assert.equal(w.students.stu_a.total, 0);
  assert.equal(w.students.stu_a.exempt, 1);
  assert.equal(w.students.stu_a.best, null);
});

test('watch-progress: 시청 기간이 끝난 영상은 403, 볼 수 없는 영상은 404', async () => {
  await seedSchool();
  await video.saveVideo({ id: 'wv-ended', title: '끝난 영상', month: '9월', week: '1주', dropboxPath: '/videos/ended.mp4', allowSchoolIds: [SCHOOL], availableUntil: '2020-01-01' });
  const cookie = await studentCookie('stu_a');
  const ended = makeRes();
  await handler({ method: 'POST', headers: { cookie }, body: { videoId: 'wv-ended', durationSec: 100, segments: [[0, 50]] }, query: { action: 'watch-progress' } }, ended);
  assert.equal(ended.statusCode, 403);
  assert.equal(ended.body.message, '시청 기간이 아닙니다');

  const notVisible = makeRes();
  await handler({ method: 'POST', headers: { cookie }, body: { videoId: 'no-such-video', durationSec: 100, segments: [[0, 50]] }, query: { action: 'watch-progress' } }, notVisible);
  assert.equal(notVisible.statusCode, 404);
  assert.equal(notVisible.body.message, '볼 수 없는 영상입니다');
});
