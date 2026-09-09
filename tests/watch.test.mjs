// 영상 단위 시청 기록(자기확인/교사정정) + 다운로드 정책 최소 회귀 테스트.
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis() {
  const store = new Map();
  return {
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
});

const auth = await import('../api/_lib/auth.js');
const course = await import('../api/_lib/course.js');
const watchHandler = (await import('../api/watch/[action].js')).default;

test('학생 자기확인: "다 봤어요" → self_confirmed/student로 저장되고 본인 조회에 반영된다', async () => {
  const schoolId = 'sch_w1', studentId = 'stu_w1', videoId = 'vidA';
  const { token } = await auth.createSession({ role: 'student', schoolId, studentId });

  const reqConfirm = {
    method: 'POST', headers: { cookie: `oheng_session=${token}` },
    body: { videoId }, query: { action: 'confirm' },
  };
  const resConfirm = makeRes();
  await watchHandler(reqConfirm, resConfirm);
  assert.equal(resConfirm.statusCode, 200);
  assert.equal(resConfirm.body.record.status, 'self_confirmed');
  assert.equal(resConfirm.body.record.source, 'student');

  const reqMine = { method: 'GET', headers: { cookie: `oheng_session=${token}` }, query: { action: 'mine', videoIds: videoId } };
  const resMine = makeRes();
  await watchHandler(reqMine, resMine);
  assert.equal(resMine.body.statuses[videoId].status, 'self_confirmed');
});

test('교사 정정: 자기확인을 teacher_confirmed로 덮어쓰면 이전 값이 history에 남는다', async () => {
  const schoolId = 'sch_w2', studentId = 'stu_w2', videoId = 'vidB';
  const { token } = await auth.createSession({ role: 'student', schoolId, studentId });
  await watchHandler(
    { method: 'POST', headers: { cookie: `oheng_session=${token}` }, body: { videoId }, query: { action: 'confirm' } },
    makeRes()
  );

  const reqSet = {
    method: 'POST', headers: { 'x-api-token': 'test-admin-token' },
    body: { schoolId, studentId, videoId, status: 'teacher_confirmed' }, query: { action: 'admin-set' },
  };
  const resSet = makeRes();
  await watchHandler(reqSet, resSet);
  assert.equal(resSet.statusCode, 200);
  assert.equal(resSet.body.record.status, 'teacher_confirmed');
  assert.equal(resSet.body.record.source, 'teacher');
  assert.equal(resSet.body.record.history.length, 1, '이전 self_confirmed 값이 감사기록으로 남아야 함');
  assert.equal(resSet.body.record.history[0].prevStatus, 'self_confirmed');

  const reqList = {
    method: 'GET', headers: { 'x-api-token': 'test-admin-token' },
    query: { action: 'admin-list', videoId, schoolId, studentIds: studentId },
  };
  const resList = makeRes();
  await watchHandler(reqList, resList);
  assert.equal(resList.body.statuses[studentId].status, 'teacher_confirmed');
});

test('다운로드 정책: 영상이 허용해도 강좌가 disabled면 최종적으로 금지된다', () => {
  const videoOff = { downloadPolicy: 'disabled' };
  const videoOn = { downloadPolicy: 'provider_offline' };
  const courseInherit = { downloadPolicy: 'inherit' };
  const courseDisabled = { downloadPolicy: 'disabled' };

  assert.equal(course.resolveDownloadPolicy(videoOff, courseInherit), 'disabled');
  assert.equal(course.resolveDownloadPolicy(videoOn, courseInherit), 'provider_offline');
  assert.equal(course.resolveDownloadPolicy(videoOn, courseDisabled), 'disabled', '강좌 금지가 영상 허용보다 우선해야 함');
});
