// 모의고사 기능 회귀 테스트.
// 실제 Upstash Redis 대신 인메모리 가짜 클라이언트를 module mock으로 주입한다.
// Node 22+의 실험적 기능이라 --experimental-test-module-mocks 플래그가 필요
// (package.json의 "test" 스크립트에 이미 포함 — `npm test`로 실행).
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis() {
  const store = new Map();   // 일반 키
  const hashes = new Map();  // 해시 키 -> Map(field -> value)
  const h = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  return {
    store, hashes,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) {
      const existed = store.has(key) || hashes.has(key);
      store.delete(key); hashes.delete(key);
      return existed ? 1 : 0;
    },
    async hget(key, field) { const m = h(key); return m.has(field) ? m.get(field) : null; },
    async hset(key, obj) {
      const m = h(key);
      Object.entries(obj).forEach(([f, v]) => m.set(f, v));
      return Object.keys(obj).length;
    },
    async hgetall(key) {
      const m = hashes.get(key);
      if (!m || m.size === 0) return null;
      return Object.fromEntries(m);
    },
    async hdel(key, field) { const m = h(key); const had = m.delete(field); return had ? 1 : 0; },
    async hlen(key) { const m = hashes.get(key); return m ? m.size : 0; },
  };
}

const fakeRedis = makeFakeRedis();
process.env.API_AUTH_TOKEN = 'test-admin-token';
// putSchoolRaw()가 학생 비밀번호를 암호화할 때 필요 (없으면 encryptPwd가 던진다)
process.env.PWD_ENC_KEY = 'test-pwd-enc-key';
// admin 핸들러가 _lib/sms.js를 import하는데, 그 파일이 모듈 로드 시점에 Solapi 클라이언트를
// 만들면서 키가 없으면 던진다. 실제 발송은 하지 않으므로 더미 값이면 충분하다.
process.env.SOLAPI_API_KEY = 'test-solapi-key';
process.env.SOLAPI_API_SECRET = 'test-solapi-secret';
// student 핸들러가 _lib/email.js를 import하는데 그 파일도 로드 시점에 Resend 클라이언트를 만든다
process.env.RESEND_API_KEY = 're_test_key';

before(() => {
  mock.module('../api/_lib/redis.js', {
    namedExports: { getRedis: () => fakeRedis },
  });
});

const mockLib = await import('../api/_lib/mock.js');
const auth = await import('../api/_lib/auth.js');
const school = await import('../api/_lib/school.js');
const adminHandler = (await import('../api/admin/[action].js')).default;
const studentHandler = (await import('../api/student/[action].js')).default;

function makeRes() {
  const res = {
    statusCode: 200, body: undefined, ended: false,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
    end() { res.ended = true; return res; },
    setHeader() {},
  };
  return res;
}
// 관리자 요청은 API_AUTH_TOKEN으로 인증한다(마스터 권한까지 함께 통과).
const ADMIN_HEADERS = { 'x-api-token': 'test-admin-token', origin: 'https://x', host: 'x' };

// school.saveSchool()은 Lua 스크립트(redis.eval)로 원자적 CAS 저장을 하는데 가짜 Redis에는
// eval이 없다. 테스트에서 학교를 만들 때는 eval을 타지 않는 putSchoolRaw()를 쓴다.
async function putSchool(id, name, grade, students) {
  return school.putSchoolRaw({ id, name, grade, type: 'regular', students, records: [] });
}

test('normalizeGrade: 공백과 고N 표기를 같은 키로 접는다', () => {
  assert.equal(mockLib.normalizeGrade(' 1학년 '), '1학년');
  assert.equal(mockLib.normalizeGrade('1 학년'), '1학년');
  assert.equal(mockLib.normalizeGrade('고1'), '1학년');
  assert.equal(mockLib.normalizeGrade('고 2'), '2학년');
  assert.equal(mockLib.normalizeGrade('3'), '3학년');
  assert.equal(mockLib.normalizeGrade('2학년'), '2학년');
  assert.equal(mockLib.normalizeGrade(''), '');
  assert.equal(mockLib.normalizeGrade(null), '');
});

test('computeAggregate: 동점은 같은 등수, 다음 등수는 건너뛴다', () => {
  const agg = mockLib.computeAggregate([
    { sid: 'a', schoolId: 'sc1', schoolName: 'A반', score: 88, grade: 2 },
    { sid: 'b', schoolId: 'sc1', schoolName: 'A반', score: 88, grade: 2 },
    { sid: 'c', schoolId: 'sc2', schoolName: 'B반', score: 85, grade: 3 },
  ]);
  assert.equal(agg.count, 3);
  assert.equal(agg.rankOf.a, 1);
  assert.equal(agg.rankOf.b, 1);
  assert.equal(agg.rankOf.c, 3, '동점 2명 뒤는 2등이 아니라 3등');
  assert.equal(agg.rankCounts[1], 2);
  assert.equal(agg.max, 88);
  assert.equal(agg.min, 85);
  assert.equal(agg.avg, 87);
  assert.equal(agg.gradeDist[2], 2);
  assert.equal(agg.bySchool.sc1.count, 2);
  assert.equal(agg.bySchool.sc2.avg, 85);
});

test('computeAggregate: excluded는 등수·평균·분모에서 완전히 빠진다', () => {
  const agg = mockLib.computeAggregate([
    { sid: 'a', schoolId: 'sc1', score: 100, grade: 1, excluded: true },
    { sid: 'b', schoolId: 'sc1', score: 80, grade: 3 },
    { sid: 'c', schoolId: 'sc1', score: 60, grade: 5 },
  ]);
  assert.equal(agg.count, 2, 'excluded는 분모에서도 빠져야 함');
  assert.equal(agg.avg, 70);
  assert.equal(agg.max, 80);
  assert.equal(agg.rankOf.a, undefined);
  assert.equal(agg.rankOf.b, 1);
  assert.equal(agg.gradeDist[1], undefined);
});

test('computeAggregate: 등급 미입력자는 gradeDist에서만 빠지고 등수에는 포함된다', () => {
  const agg = mockLib.computeAggregate([
    { sid: 'a', schoolId: 'sc1', score: 90, grade: null },
    { sid: 'b', schoolId: 'sc1', score: 70, grade: 4 },
  ]);
  assert.equal(agg.count, 2);
  assert.equal(agg.rankOf.a, 1);
  assert.deepEqual(agg.gradeDist, { 4: 1 });
});

test('parseScore / parseGradeLevel: 범위 밖 값은 거부한다', () => {
  assert.equal(mockLib.parseScore(88, 100), 88);
  assert.equal(mockLib.parseScore('88', 100), 88);
  assert.equal(mockLib.parseScore(0, 100), 0);
  assert.equal(mockLib.parseScore(101, 100), null);
  assert.equal(mockLib.parseScore(-1, 100), null);
  assert.equal(mockLib.parseScore(88.5, 100), null);
  assert.equal(mockLib.parseScore('', 100), null);

  assert.deepEqual(mockLib.parseGradeLevel(3), { ok: true, value: 3 });
  assert.deepEqual(mockLib.parseGradeLevel('3'), { ok: true, value: 3 });
  assert.deepEqual(mockLib.parseGradeLevel(null), { ok: true, value: null });
  assert.deepEqual(mockLib.parseGradeLevel(''), { ok: true, value: null });
  assert.equal(mockLib.parseGradeLevel(0).ok, false);
  assert.equal(mockLib.parseGradeLevel(10).ok, false);
  assert.equal(mockLib.parseGradeLevel('상').ok, false);
});

test('isRoundOpen: openAt 이상 closeAt 미만일 때만 열려 있다', () => {
  const round = { openAt: 100, closeAt: 200 };
  assert.equal(mockLib.isRoundOpen(round, 99), false);
  assert.equal(mockLib.isRoundOpen(round, 100), true);
  assert.equal(mockLib.isRoundOpen(round, 199), true);
  assert.equal(mockLib.isRoundOpen(round, 200), false, 'closeAt 시점은 이미 마감');
});

test('studentViewOf: 마감 전에는 등수·평균을 내려보내지 않는다', () => {
  const round = { id: 'r1', title: '3월 학평', examDate: '2026.03.26', grade: '1학년', maxScore: 100, closeAt: Date.now() + 100000 };
  const sub = { sid: 'a', score: 88, grade: 2 };
  const agg = { count: 40, avg: 70, max: 98, rankOf: { a: 5 }, rankCounts: { 5: 1 }, gradeDist: { 2: 10 } };
  const view = mockLib.studentViewOf(round, sub, agg);
  assert.equal(view.score, 88);
  assert.equal(view.rank, null, '마감 전에는 등수를 숨긴다');
  assert.equal(view.avg, null);
  assert.equal(view.gradeDist, null);
});

test('studentViewOf: 응시자 5명 미만이면 마감 후에도 평균을 숨긴다', () => {
  const round = { id: 'r1', title: '3월 학평', examDate: '2026.03.26', grade: '1학년', maxScore: 100, closeAt: 1 };
  const sub = { sid: 'a', score: 88, grade: 2 };
  const few = { count: 4, avg: 70, max: 98, rankOf: { a: 1 }, rankCounts: { 1: 1 }, gradeDist: { 2: 1 } };
  const fewView = mockLib.studentViewOf(round, sub, few);
  assert.equal(fewView.rank, null);
  assert.equal(fewView.avg, null);
  assert.equal(fewView.count, 4, '응시자 수 자체는 보여준다');

  const many = { count: 5, avg: 70, max: 98, rankOf: { a: 1 }, rankCounts: { 1: 2 }, gradeDist: { 2: 1 } };
  const manyView = mockLib.studentViewOf(round, sub, many);
  assert.equal(manyView.avg, 70);
  assert.equal(manyView.max, 98);
  assert.deepEqual(manyView.gradeDist, { 2: 1 });
  assert.equal(manyView.rank, null, '등수는 마감 후에도 학생에게 내려보내지 않는다');
  assert.equal(manyView.tieCount, null);
});

test('studentViewOf: 등수는 어떤 경우에도 학생 응답에 담기지 않는다', () => {
  const round = { id: 'r1', title: '3월 학평', examDate: '2026.03.26', grade: '1학년', maxScore: 100, closeAt: 1 };
  const agg = { count: 40, avg: 70, max: 98, rankOf: { a: 1, b: 2 }, rankCounts: { 1: 1, 2: 1 }, gradeDist: { 2: 10 } };
  for (const sid of ['a', 'b']) {
    const view = mockLib.studentViewOf(round, { sid, score: 88, grade: 2 }, agg);
    assert.equal(view.rank, null);
    assert.equal(view.tieCount, null);
    assert.equal(JSON.stringify(view).includes('rankOf'), false, '집계 원본이 새어나가면 안 됨');
  }
});

test('saveRound → listRounds → getRound: 회차가 저장되고 응시일 내림차순으로 나온다', async () => {
  const march = await mockLib.saveRound({
    grade: '고1', title: '2026년 3월 학력평가', examDate: '2026.03.26',
    openAt: 1, closeAt: 2, maxScore: 100,
  }, 'master');
  assert.equal(march.grade, '1학년', 'saveRound는 학년을 정규화해서 저장해야 함');
  assert.ok(march.id.startsWith('mr'));
  const second = await mockLib.saveRound({
    grade: '1학년', title: '같은 밀리초 회차', examDate: '2026.03.27',
    openAt: 1, closeAt: 2, maxScore: 100,
  }, 'master');
  assert.notEqual(second.id, march.id, '연속으로 만들어도 id가 겹치면 안 됨');

  await mockLib.saveRound({
    grade: '1학년', title: '2026년 6월 모의평가', examDate: '2026.06.04',
    openAt: 1, closeAt: 2, maxScore: 100,
  }, 'master');

  const rounds = await mockLib.listRounds();
  assert.equal(rounds.length, 3);
  assert.equal(rounds[0].examDate, '2026.06.04', '최신 회차가 먼저');

  const again = await mockLib.getRound(march.id);
  assert.equal(again.title, '2026년 3월 학력평가');
});

test('saveRound: 잘못된 입력은 MockError로 거부한다', async () => {
  await assert.rejects(
    () => mockLib.saveRound({ grade: '', title: 'x', examDate: '2026.03.26', openAt: 1, closeAt: 2 }, 'm'),
    (e) => e instanceof mockLib.MockError && e.status === 400
  );
  await assert.rejects(
    () => mockLib.saveRound({ grade: '1학년', title: '', examDate: '2026.03.26', openAt: 1, closeAt: 2 }, 'm'),
    (e) => e.status === 400
  );
  await assert.rejects(
    () => mockLib.saveRound({ grade: '1학년', title: 'x', examDate: '2026-03-26', openAt: 1, closeAt: 2 }, 'm'),
    (e) => e.status === 400
  );
  await assert.rejects(
    () => mockLib.saveRound({ grade: '1학년', title: 'x', examDate: '2026.03.26', openAt: 5, closeAt: 5 }, 'm'),
    (e) => e.status === 400
  );
});

test('putSubmission → getAggregate: 제출하면 집계가 자동으로 갱신된다', async () => {
  const round = await mockLib.saveRound({
    grade: '2학년', title: '집계 테스트', examDate: '2026.09.01',
    openAt: 1, closeAt: Date.now() + 100000, maxScore: 100,
  }, 'master');

  await mockLib.putSubmission(round.id, { sid: 's1', schoolId: 'sc1', schoolName: 'A반', name: '가', score: 90, grade: 1 });
  await mockLib.putSubmission(round.id, { sid: 's2', schoolId: 'sc1', schoolName: 'A반', name: '나', score: 70, grade: 4 });

  assert.equal(await mockLib.countSubmissions(round.id), 2);
  const agg = await mockLib.getAggregate(round.id);
  assert.equal(agg.count, 2);
  assert.equal(agg.avg, 80);
  assert.equal(agg.rankOf.s1, 1);

  const one = await mockLib.getSubmission(round.id, 's2');
  assert.equal(one.score, 70);
});

test('getAggregate: 캐시가 없으면 그 자리에서 다시 계산한다', async () => {
  const round = await mockLib.saveRound({
    grade: '3학년', title: '캐시 테스트', examDate: '2026.09.02',
    openAt: 1, closeAt: Date.now() + 100000, maxScore: 100,
  }, 'master');
  await mockLib.putSubmission(round.id, { sid: 'x1', schoolId: 'sc9', schoolName: 'C반', name: '다', score: 50, grade: 6 });

  fakeRedis.store.delete('mock:agg:' + round.id);  // 캐시 유실 상황을 흉내
  const agg = await mockLib.getAggregate(round.id);
  assert.equal(agg.count, 1, '캐시가 없어도 제출에서 다시 계산해야 함');
  assert.equal(agg.avg, 50);
});

test('removeSubmission / deleteRound: 제출과 집계가 함께 정리된다', async () => {
  const round = await mockLib.saveRound({
    grade: '1학년', title: '삭제 테스트', examDate: '2026.09.03',
    openAt: 1, closeAt: Date.now() + 100000, maxScore: 100,
  }, 'master');
  await mockLib.putSubmission(round.id, { sid: 'd1', schoolId: 'sc1', schoolName: 'A반', name: '라', score: 60, grade: 5 });
  await mockLib.putSubmission(round.id, { sid: 'd2', schoolId: 'sc1', schoolName: 'A반', name: '마', score: 80, grade: 3 });

  const afterRemove = await mockLib.removeSubmission(round.id, 'd1');
  assert.equal(afterRemove.count, 1);
  assert.equal(await mockLib.getSubmission(round.id, 'd1'), null);

  await mockLib.deleteRound(round.id);
  assert.equal(await mockLib.getRound(round.id), null);
  assert.equal(await mockLib.countSubmissions(round.id), 0);
  assert.equal(fakeRedis.store.has('mock:agg:' + round.id), false);
});

test('mock-round-save → mock-rounds: 회차를 만들고 제출률과 함께 목록에 나온다', async () => {
  await school.createSchool('테스트고', '고1', 'regular');

  const saveRes = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-round-save' },
    body: { grade: '1학년', title: 'API 회차', examDate: '2026.03.26', openAt: 1, closeAt: Date.now() + 100000, maxScore: 100 },
  }, saveRes);
  assert.equal(saveRes.statusCode, 200);
  const roundId = saveRes.body.round.id;

  const listRes = makeRes();
  await adminHandler({
    method: 'GET', headers: ADMIN_HEADERS, query: { action: 'mock-rounds', grade: '1학년' },
  }, listRes);
  assert.equal(listRes.statusCode, 200);
  const row = listRes.body.rounds.find(r => r.id === roundId);
  assert.ok(row, '방금 만든 회차가 목록에 있어야 함');
  assert.equal(row.submittedCount, 0);
  assert.ok(row.totalCount >= 0);
  assert.ok(listRes.body.grades.includes('1학년'), '현존 학년 목록을 함께 내려줘야 함');
});

test('mock-round-save: 잘못된 입력은 400으로 거부한다', async () => {
  const res = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-round-save' },
    body: { grade: '1학년', title: '', examDate: '2026.03.26', openAt: 1, closeAt: 2 },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /제목/);
});

test('mock-round-delete: 회차와 제출이 함께 사라진다', async () => {
  const saveRes = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-round-save' },
    body: { grade: '2학년', title: '지울 회차', examDate: '2026.05.01', openAt: 1, closeAt: Date.now() + 100000, maxScore: 100 },
  }, saveRes);
  const roundId = saveRes.body.round.id;
  await mockLib.putSubmission(roundId, { sid: 'z1', schoolId: 'sc1', schoolName: 'A반', name: '바', score: 70, grade: 4 });

  const delRes = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-round-delete' }, body: { id: roundId },
  }, delRes);
  assert.equal(delRes.statusCode, 200);
  assert.equal(await mockLib.getRound(roundId), null);
  assert.equal(await mockLib.countSubmissions(roundId), 0);
});

test('mock-detail: 그 반의 제출·미제출자와 학년 전체 집계를 함께 준다', async () => {
  const sc = await putSchool('sc_detail', '상세고', '3학년', [
    { id: 'sd1', name: '제출학생', pwd: '1234' },
    { id: 'sd2', name: '미제출학생', pwd: '1234' },
  ]);

  const saveRes = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-round-save' },
    body: { grade: '3학년', title: '상세 회차', examDate: '2026.07.01', openAt: 1, closeAt: Date.now() + 100000, maxScore: 100 },
  }, saveRes);
  const roundId = saveRes.body.round.id;
  await mockLib.putSubmission(roundId, { sid: 'sd1', schoolId: sc.id, schoolName: sc.name, name: '제출학생', score: 77, grade: 3 });

  const res = makeRes();
  await adminHandler({
    method: 'GET', headers: ADMIN_HEADERS, query: { action: 'mock-detail', roundId, schoolId: sc.id },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.submissions.length, 1);
  assert.equal(res.body.submissions[0].name, '제출학생');
  assert.equal(res.body.missing.length, 1);
  assert.equal(res.body.missing[0].id, 'sd2');
  assert.equal(res.body.aggregate.count, 1);
});

test('mock-edit: 선생님이 점수를 고치면 집계가 다시 계산되고 editedBy가 남는다', async () => {
  const sc = await putSchool('sc_edit', '수정고', '1학년', [{ id: 'se1', name: '수정대상', pwd: '1234' }]);

  const saveRes = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-round-save' },
    body: { grade: '1학년', title: '수정 회차', examDate: '2026.08.01', openAt: 1, closeAt: Date.now() + 100000, maxScore: 100 },
  }, saveRes);
  const roundId = saveRes.body.round.id;
  await mockLib.putSubmission(roundId, { sid: 'se1', schoolId: sc.id, schoolName: sc.name, name: '수정대상', score: 50, grade: 6 });

  const res = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-edit' },
    body: { roundId, sid: 'se1', score: 95, grade: 1 },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.submission.score, 95);
  assert.ok(res.body.submission.editedBy !== null, '누가 고쳤는지 남아야 함');
  assert.equal(res.body.aggregate.avg, 95);
});

test('mock-edit: 미제출자도 선생님이 대신 입력할 수 있다 (마감 후 유일한 입력 경로)', async () => {
  const sc = await putSchool('sc_proxy', '대리고', '2학년', [{ id: 'sf1', name: '대리입력', pwd: '1234' }]);

  const saveRes = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-round-save' },
    body: { grade: '2학년', title: '대리 회차', examDate: '2026.08.02', openAt: 1, closeAt: 2, maxScore: 100 },
  }, saveRes);
  const roundId = saveRes.body.round.id;   // 이미 마감된 회차

  const res = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-edit' },
    body: { roundId, sid: 'sf1', schoolId: sc.id, score: 62, grade: 5 },
  }, res);
  assert.equal(res.statusCode, 200, '마감된 회차라도 선생님은 입력할 수 있어야 함');
  assert.equal(res.body.submission.name, '대리입력', '학생 이름을 학교에서 찾아 스냅샷으로 넣어야 함');
  assert.equal(res.body.submission.score, 62);
});

test('mock-edit: excluded 처리하면 집계 분모에서 빠진다', async () => {
  const sc = await putSchool('sc_exclude', '제외고', '1학년', [
    { id: 'sg1', name: '제외대상', pwd: '1234' },
    { id: 'sg2', name: '정상', pwd: '1234' },
  ]);

  const saveRes = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-round-save' },
    body: { grade: '1학년', title: '제외 회차', examDate: '2026.08.03', openAt: 1, closeAt: Date.now() + 100000, maxScore: 100 },
  }, saveRes);
  const roundId = saveRes.body.round.id;
  await mockLib.putSubmission(roundId, { sid: 'sg1', schoolId: sc.id, schoolName: sc.name, name: '제외대상', score: 100, grade: 1 });
  await mockLib.putSubmission(roundId, { sid: 'sg2', schoolId: sc.id, schoolName: sc.name, name: '정상', score: 60, grade: 5 });

  const res = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-edit' },
    body: { roundId, sid: 'sg1', excluded: true, memo: '중복 응시' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.aggregate.count, 1);
  assert.equal(res.body.aggregate.avg, 60);
});

test('mock-edit: 점수 범위 밖 값은 400으로 거부한다', async () => {
  const saveRes = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-round-save' },
    body: { grade: '1학년', title: '검증 회차', examDate: '2026.08.04', openAt: 1, closeAt: Date.now() + 100000, maxScore: 100 },
  }, saveRes);
  const roundId = saveRes.body.round.id;

  const res = makeRes();
  await adminHandler({
    method: 'POST', headers: ADMIN_HEADERS, query: { action: 'mock-edit' },
    body: { roundId, sid: 'sg2', schoolId: 'sc_exclude', score: 250 },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /점수/);
});

test('학생 mock 조회: 열린 회차와 제출 현황이 내려온다', async () => {
  // 다른 테스트가 만든 열린 회차와 섞이지 않도록, 이 테스트에서만 쓰는 학년을 쓴다
  // (한 파일의 테스트들이 fakeRedis를 공유한다)
  const sc = await putSchool('sc_view', '학생조회고', '4학년', [{ id: 'st1', name: '조회학생', pwd: '1234' }]);
  const { token } = await auth.createSession({ role: 'student', schoolId: sc.id, studentId: 'st1' });

  const round = await mockLib.saveRound({
    grade: '4학년', title: '학생용 회차', examDate: '2026.03.26',
    openAt: 1, closeAt: Date.now() + 100000, maxScore: 100,
  }, 'master');

  const res = makeRes();
  await studentHandler({
    method: 'GET', headers: { cookie: `oheng_session=${token}` }, query: { action: 'mock' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.openRound.id, round.id);
  assert.equal(res.body.openRound.mySubmission, null);
  assert.equal(res.body.openRound.submittedCount, 0);
  // 한 파일의 테스트들이 fakeRedis를 공유하므로 같은 학년 학교가 누적된다 — 정확값 대신 하한만 본다
  assert.ok(res.body.openRound.totalCount >= 1);
  assert.deepEqual(res.body.history, []);
});

test('학생 mock-submit: 제출하면 조회에 반영되고 재제출은 덮어쓴다', async () => {
  const sc = await putSchool('sc_submit', '제출고', '2학년', [{ id: 'st2', name: '제출학생', pwd: '1234' }]);
  const { token } = await auth.createSession({ role: 'student', schoolId: sc.id, studentId: 'st2' });
  const headers = { cookie: `oheng_session=${token}`, origin: 'https://x', host: 'x' };

  const round = await mockLib.saveRound({
    grade: '2학년', title: '제출 회차', examDate: '2026.03.26',
    openAt: 1, closeAt: Date.now() + 100000, maxScore: 100,
  }, 'master');

  const res1 = makeRes();
  await studentHandler({ method: 'POST', headers, query: { action: 'mock-submit' }, body: { roundId: round.id, score: 88, grade: 2 } }, res1);
  assert.equal(res1.statusCode, 200);

  const res2 = makeRes();
  await studentHandler({ method: 'POST', headers, query: { action: 'mock-submit' }, body: { roundId: round.id, score: 91, grade: 1 } }, res2);
  assert.equal(res2.statusCode, 200);

  assert.equal(await mockLib.countSubmissions(round.id), 1, '재제출은 새 행이 아니라 덮어쓰기');
  const stored = await mockLib.getSubmission(round.id, 'st2');
  assert.equal(stored.score, 91);
  assert.equal(stored.name, '제출학생', '이름을 스냅샷으로 남겨야 함');
  assert.equal(stored.schoolName, '제출고');
});

test('학생 mock-submit: 마감된 회차와 다른 학년 회차는 거부한다', async () => {
  const sc = await putSchool('sc_reject', '거부고', '3학년', [{ id: 'st3', name: '거부학생', pwd: '1234' }]);
  const { token } = await auth.createSession({ role: 'student', schoolId: sc.id, studentId: 'st3' });
  const headers = { cookie: `oheng_session=${token}`, origin: 'https://x', host: 'x' };

  const closed = await mockLib.saveRound({ grade: '3학년', title: '마감됨', examDate: '2026.01.01', openAt: 1, closeAt: 2, maxScore: 100 }, 'm');
  const resClosed = makeRes();
  await studentHandler({ method: 'POST', headers, query: { action: 'mock-submit' }, body: { roundId: closed.id, score: 50 } }, resClosed);
  assert.equal(resClosed.statusCode, 403);
  assert.match(resClosed.body.message, /마감/);

  const otherGrade = await mockLib.saveRound({ grade: '1학년', title: '남의 학년', examDate: '2026.04.01', openAt: 1, closeAt: Date.now() + 100000, maxScore: 100 }, 'm');
  const resGrade = makeRes();
  await studentHandler({ method: 'POST', headers, query: { action: 'mock-submit' }, body: { roundId: otherGrade.id, score: 50 } }, resGrade);
  assert.equal(resGrade.statusCode, 403);
});

test('학생 mock-submit: 점수·등급 검증을 서버에서 다시 한다', async () => {
  const sc = await putSchool('sc_valid', '검증고', '1학년', [{ id: 'st4', name: '검증학생', pwd: '1234' }]);
  const { token } = await auth.createSession({ role: 'student', schoolId: sc.id, studentId: 'st4' });
  const headers = { cookie: `oheng_session=${token}`, origin: 'https://x', host: 'x' };
  const round = await mockLib.saveRound({ grade: '1학년', title: '검증', examDate: '2026.04.02', openAt: 1, closeAt: Date.now() + 100000, maxScore: 100 }, 'm');

  const resScore = makeRes();
  await studentHandler({ method: 'POST', headers, query: { action: 'mock-submit' }, body: { roundId: round.id, score: 120 } }, resScore);
  assert.equal(resScore.statusCode, 400);

  const resGrade = makeRes();
  await studentHandler({ method: 'POST', headers, query: { action: 'mock-submit' }, body: { roundId: round.id, score: 80, grade: 12 } }, resGrade);
  assert.equal(resGrade.statusCode, 400);
});

test('학생 mock 조회: 학년이 올라가도 지난 학년 회차가 history에 남는다', async () => {
  const sc = await putSchool('sc_promote', '진급고', '1학년', [{ id: 'st5', name: '진급학생', pwd: '1234' }]);
  const { token } = await auth.createSession({ role: 'student', schoolId: sc.id, studentId: 'st5' });

  // 1학년 때 본 마감된 회차 — 응시자 5명을 채워 등수가 공개되는 상태로 만든다
  const g1 = await mockLib.saveRound({ grade: '1학년', title: '1학년 3월', examDate: '2026.03.26', openAt: 1, closeAt: 2, maxScore: 100 }, 'm');
  await mockLib.putSubmission(g1.id, { sid: 'st5', schoolId: sc.id, schoolName: sc.name, name: '진급학생', score: 88, grade: 2 });
  for (let i = 0; i < 4; i++) {
    await mockLib.putSubmission(g1.id, { sid: 'other' + i, schoolId: sc.id, schoolName: sc.name, name: '기타', score: 60 + i, grade: 5 });
  }

  // 반이 통째로 2학년이 됨 — 학교의 학년만 바꾼다 (반도 학생도 그대로)
  await putSchool('sc_promote', '진급고', '2학년', [{ id: 'st5', name: '진급학생', pwd: '1234' }]);

  const res = makeRes();
  await studentHandler({ method: 'GET', headers: { cookie: `oheng_session=${token}` }, query: { action: 'mock' } }, res);
  assert.equal(res.statusCode, 200);
  const past = res.body.history.find(h => h.roundId === g1.id);
  assert.ok(past, '2학년이 되어도 1학년 회차가 history에 남아야 함');
  assert.equal(past.score, 88);
  assert.equal(past.rank, null, '학생에게는 등수를 내려보내지 않는다');
  assert.equal(past.count, 5);
  assert.equal(past.avg, 66.8);  // (88+60+61+62+63)/5
  // 다른 학생 정보가 새어나가지 않는지
  assert.equal(JSON.stringify(res.body).includes('기타'), false, '다른 학생 이름이 응답에 있으면 안 됨');
});
