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
const playback = await import('../api/_lib/playback.js');
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

test('isVideoVisibleForOwner: 허용된 학생에게는 영상을, 예외 차단된 학생과 존재하지 않는 owner에게는 null을 돌려준다', async () => {
  await video.saveVideo({ id: 'vis-1', title: '가시성 테스트', dropboxPath: '/videos/vis.mp4', allowSchoolIds: [SCHOOL], excludeStudentIds: ['stu_blocked2'] });
  const sc = (await fakeRedis.get('school:' + SCHOOL)) || { id: SCHOOL, name: '재생테스트고', version: 0, students: [], withdrawnStudents: [] };
  sc.students = sc.students.filter(s => !['stu_vis', 'stu_blocked2'].includes(s.id)).concat([
    { id: 'stu_vis', name: '학생vis', entitlements: [] },
    { id: 'stu_blocked2', name: '학생blocked', entitlements: [] },
  ]);
  await fakeRedis.set('school:' + SCHOOL, sc);

  const allowed = await playback.isVideoVisibleForOwner({ ownerType: 'student', ownerId: `${SCHOOL}:stu_vis` }, 'vis-1');
  assert.equal(allowed?.id, 'vis-1');

  const blocked = await playback.isVideoVisibleForOwner({ ownerType: 'student', ownerId: `${SCHOOL}:stu_blocked2` }, 'vis-1');
  assert.equal(blocked, null);

  const noEntitlements = await playback.isVideoVisibleForOwner({ ownerType: 'member', ownerId: 'no-such-member' }, 'vis-1');
  assert.equal(noEntitlements, null);
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

test('play-url: 재적 명단에서 빠진(퇴원) 학생은 404이고 드롭박스를 부르지 않는다', async () => {
  const sc = (await fakeRedis.get('school:' + SCHOOL)) || { id: SCHOOL, name: '재생테스트고', version: 0, students: [], withdrawnStudents: [] };
  sc.students = sc.students.filter(s => s.id !== 'stu_gone');
  sc.withdrawnStudents = (sc.withdrawnStudents || []).filter(s => s.id !== 'stu_gone').concat([{ id: 'stu_gone', name: '퇴원학생' }]);
  await fakeRedis.set('school:' + SCHOOL, sc);
  const { token } = await auth.createSession({ role: 'student', schoolId: SCHOOL, studentId: 'stu_gone' });
  const cookie = `oheng_session=${token}`;
  const res = await playUrl(cookie, 'pv-open');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, '볼 수 없는 영상입니다');
  assert.equal(tempLinkCalls.length, 0);
});
