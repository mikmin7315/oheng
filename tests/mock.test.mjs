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

before(() => {
  mock.module('../api/_lib/redis.js', {
    namedExports: { getRedis: () => fakeRedis },
  });
});

const mockLib = await import('../api/_lib/mock.js');

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

test('studentViewOf: 응시자 5명 미만이면 마감 후에도 등수·평균을 숨긴다', () => {
  const round = { id: 'r1', title: '3월 학평', examDate: '2026.03.26', grade: '1학년', maxScore: 100, closeAt: 1 };
  const sub = { sid: 'a', score: 88, grade: 2 };
  const few = { count: 4, avg: 70, max: 98, rankOf: { a: 1 }, rankCounts: { 1: 1 }, gradeDist: { 2: 1 } };
  const fewView = mockLib.studentViewOf(round, sub, few);
  assert.equal(fewView.rank, null);
  assert.equal(fewView.avg, null);
  assert.equal(fewView.count, 4, '응시자 수 자체는 보여준다');

  const many = { count: 5, avg: 70, max: 98, rankOf: { a: 1 }, rankCounts: { 1: 2 }, gradeDist: { 2: 1 } };
  const manyView = mockLib.studentViewOf(round, sub, many);
  assert.equal(manyView.rank, 1);
  assert.equal(manyView.tieCount, 2);
  assert.equal(manyView.avg, 70);
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
