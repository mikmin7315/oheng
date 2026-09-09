// 최소 회귀 테스트: 강좌 저장 → 공개목록 → 신청 → 수강권 부여 → 회원 영상순서까지
// 이어지는 핵심 흐름과, 최근 발견된 버그 3건(영상 재생순서 미반영/썸네일 스킴/비공개
// 강좌 신청 차단)의 재발을 막기 위한 테스트.
//
// 실제 Upstash Redis 대신 인메모리 가짜 클라이언트를 module mock으로 주입한다.
// Node 22+의 실험적 기능이라 --experimental-test-module-mocks 플래그가 필요
// (package.json의 "test" 스크립트에 이미 포함되어 있음 — `npm test`로 실행).
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis() {
  const store = new Map();
  return {
    store,
    // 깊은 복제로 반환 — 실제 Redis처럼 GET한 객체를 호출부가 마음대로 수정해도
    // store 안의 값(그리고 이후 CAS eval의 버전 비교)에 영향을 주지 않게 한다.
    // (참조를 그대로 돌려주면 mutateSchool의 in-place mutateFn이 저장된 값까지
    // 즉시 바꿔버려서 버전 충돌을 오탐한다.)
    async get(key) { return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) { const existed = store.has(key); store.delete(key); return existed ? 1 : 0; },
    async incr(key) { const v = (store.get(key) || 0) + 1; store.set(key, v); return v; },
    // school.js의 CAS_SET_SCRIPT 전용 흉내 — 버전 확인 후 원자적으로 SET.
    // 실제 Upstash는 값을 문자열로 저장했다가 다시 객체로 자동 역직렬화하지만, 여기선
    // 나머지 메서드처럼 객체를 그대로 저장해 단순화한다(school.js 주석 참고).
    async eval(script, keys, args) {
      const key = keys[0];
      const expected = parseInt(args[0], 10);
      const newValJson = args[1];
      const cur = store.has(key) ? store.get(key) : null;
      if (cur === null) return ['not_found', ''];
      const curVersion = cur.version || 0;
      if (curVersion !== expected) return ['conflict', JSON.stringify(cur)];
      store.set(key, JSON.parse(newValJson));
      return ['ok', newValJson];
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    ended: false,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
    end() { res.ended = true; return res; },
    setHeader() {},
  };
  return res;
}

const fakeRedis = makeFakeRedis();
process.env.API_AUTH_TOKEN = 'test-admin-token';

before(() => {
  mock.module('../api/_lib/redis.js', {
    namedExports: { getRedis: () => fakeRedis },
  });
});

const course = await import('../api/_lib/course.js');
const member = await import('../api/_lib/member.js');
const auth = await import('../api/_lib/auth.js');
const school = await import('../api/_lib/school.js');
const entitlements = await import('../api/_lib/entitlements.js');
const courseHandler = (await import('../api/courses/[action].js')).default;

test('강좌 저장 → 공개목록: 미게시 강좌는 목록에서 빠지고, 게시된 강좌는 level/thumbnailUrl 포함', async () => {
  const draft = await course.saveCourse({ title: '초안 강좌', price: 1000, published: false });
  const live = await course.saveCourse({
    title: '고1 문법 특강', price: 50000, durationDays: 30,
    level: '고등/수능', thumbnailUrl: 'https://img.example.com/a.jpg', published: true,
  });

  const publicList = await course.listPublishedCoursesForPublic();
  assert.ok(!publicList.some(c => c.id === draft.id), '미게시 강좌는 공개 목록에 없어야 함');
  const found = publicList.find(c => c.id === live.id);
  assert.ok(found, '게시된 강좌는 공개 목록에 있어야 함');
  assert.equal(found.level, '고등/수능');
  assert.equal(found.thumbnailUrl, 'https://img.example.com/a.jpg');
});

test('썸네일 URL: http(s)만 허용, javascript:/data: 등은 저장 시 제거됨', async () => {
  const bad = await course.saveCourse({ title: 'XSS 시도', published: true, thumbnailUrl: 'javascript:alert(1)' });
  assert.equal(bad.thumbnailUrl, '');
  const ok = await course.saveCourse({ title: '정상 썸네일', published: true, thumbnailUrl: 'https://img.example.com/b.jpg' });
  assert.equal(ok.thumbnailUrl, 'https://img.example.com/b.jpg');
});

test('신청 → 관리자 목록 확인 → 비공개 강좌는 신청 API가 거부', async () => {
  const draft = await course.saveCourse({ title: '비공개 강좌', published: false });
  const memberId = 'mem_test_apply';
  await fakeRedis.set('member:' + memberId, { id: memberId, name: '김테스트', phone: '01000000000', entitlements: [] });
  const { token } = await auth.createSession({ role: 'member', memberId });

  const req = {
    method: 'POST', headers: { cookie: `oheng_session=${token}` },
    body: { courseId: draft.id }, query: { action: 'apply' },
  };
  const res = makeRes();
  await courseHandler(req, res);
  assert.equal(res.statusCode, 404, '비공개(미게시) 강좌는 신청이 거부되어야 함');

  const live = await course.saveCourse({ title: '공개 강좌', published: true, durationDays: 30 });
  const req2 = {
    method: 'POST', headers: { cookie: `oheng_session=${token}` },
    body: { courseId: live.id }, query: { action: 'apply' },
  };
  const res2 = makeRes();
  await courseHandler(req2, res2);
  assert.equal(res2.statusCode, 200, '공개 강좌 신청은 성공해야 함');

  const applicants = await course.listApplicants(live.id);
  assert.ok(applicants.some(a => a.memberId === memberId), '신청자 목록에 포함되어야 함');

  return { live, memberId, token };
});

test('수강권 부여 → 신청자 목록에서 자동 제거 → 회원 영상 목록에 강좌 영상이 course.videoIds 순서로 반영', async () => {
  const memberId = 'mem_test_grant';

  // 영상은 v3, v1, v2 순서로 "생성"되지만(listAllVideos 순서), 강좌엔 v1→v2→v3 순으로 등록한다.
  await fakeRedis.set('video:v3', { id: 'v3', title: '3강', month: '1월', week: '3주', mediaKey: 'k3' });
  await fakeRedis.set('video:v1', { id: 'v1', title: '1강', month: '1월', week: '1주', mediaKey: 'k1' });
  await fakeRedis.set('video:v2', { id: 'v2', title: '2강', month: '1월', week: '2주', mediaKey: 'k2' });
  await fakeRedis.set('video:index', ['v3', 'v1', 'v2']);

  const live = await course.saveCourse({
    title: '순서 테스트 강좌', published: true, durationDays: 14,
    videoIds: ['v1', 'v2', 'v3'],
  });

  await fakeRedis.set('member:' + memberId, { id: memberId, name: '박테스트', phone: '01011112222', entitlements: [] });
  await course.applyToCourse(live.id, memberId);

  const req = {
    method: 'POST', headers: { 'x-api-token': 'test-admin-token' },
    body: { memberId, courseId: live.id, days: 14 }, query: { action: 'grant-entitlement' },
  };
  const res = makeRes();
  await courseHandler(req, res);
  assert.equal(res.statusCode, 200, '수강권 부여는 성공해야 함');
  assert.equal(res.body.owner.ownerType, 'member');
  assert.equal(res.body.entitlements[0].status, 'active');

  const remaining = await course.listApplicants(live.id);
  assert.ok(!remaining.some(a => a.memberId === memberId), '수강권 부여 후 신청자 목록에서 빠져야 함');

  const updatedMember = await member.getMember(memberId);
  const videos = await course.listVideosForMember(updatedMember);
  assert.deepEqual(videos.map(v => v.id), ['v1', 'v2', 'v3'], '회원 영상 목록은 course.videoIds 순서를 따라야 함(전체 영상 목록 순서 아님)');
  assert.equal(videos[0].courseTitle, '순서 테스트 강좌');
});

test('학생도 회원과 동일하게 강좌를 결제·구매하고, 학생 레코드에 수강권이 저장된다', async () => {
  const schoolId = 'sch_test1';
  const studentId = 'stu_test1';
  await fakeRedis.set('school:' + schoolId, {
    id: schoolId, name: '테스트고', version: 0,
    students: [{ id: studentId, name: '학생테스트', entitlements: [] }],
    withdrawnStudents: [],
  });
  const live = await course.saveCourse({ title: '학생용 강좌', price: 5000, published: true, durationDays: 10 });

  const { token } = await auth.createSession({ role: 'student', schoolId, studentId });
  const req1 = {
    method: 'POST', headers: { cookie: `oheng_session=${token}` },
    body: { courseId: live.id }, query: { action: 'create-payment' },
  };
  const res1 = makeRes();
  await courseHandler(req1, res1);
  assert.equal(res1.statusCode, 200, '학생도 결제 생성이 가능해야 함');
  const paymentId = res1.body.payment.paymentId;

  // 이 테스트는 포트원 실제 API를 호출하지 않고 라이브러리 함수만 직접 검증하므로,
  // getPayment을 호출하는 verifyAndCompletePayment 대신 setOwnerEntitlements를 직접 확인.
  await entitlements.setOwnerEntitlements('student', entitlements.makeStudentOwnerId(schoolId, studentId), [
    { courseId: live.id, purchasedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 864e5).toISOString(), paymentId, amount: 5000, status: 'active', source: 'payment' },
  ]);

  const savedSchool = await school.getSchool(schoolId);
  const savedStudent = savedSchool.students.find(s => s.id === studentId);
  assert.equal(savedStudent.entitlements[0].courseId, live.id);
  assert.equal(savedStudent.entitlements[0].status, 'active');

  // /api/courses/mine도 학생 세션으로 같은 강좌 영상을 돌려줘야 함
  const req2 = { method: 'GET', headers: { cookie: `oheng_session=${token}` }, query: { action: 'mine' } };
  const res2 = makeRes();
  await courseHandler(req2, res2);
  assert.equal(res2.statusCode, 200);
});

test('결제 완료 확인은 결제를 만든 본인 세션에서만 가능하다(다른 로그인 계정이 남의 paymentId로 완료 처리 시도하면 거부)', async () => {
  const memberA = 'mem_owner_a';
  const memberB = 'mem_owner_b';
  await fakeRedis.set('member:' + memberA, { id: memberA, name: 'A', entitlements: [] });
  await fakeRedis.set('member:' + memberB, { id: memberB, name: 'B', entitlements: [] });
  const live = await course.saveCourse({ title: '소유자확인 강좌', price: 3000, published: true, durationDays: 10 });

  const sessionA = await auth.createSession({ role: 'member', memberId: memberA });
  const reqCreate = {
    method: 'POST', headers: { cookie: `oheng_session=${sessionA.token}` },
    body: { courseId: live.id }, query: { action: 'create-payment' },
  };
  const resCreate = makeRes();
  await courseHandler(reqCreate, resCreate);
  const paymentId = resCreate.body.payment.paymentId;

  const sessionB = await auth.createSession({ role: 'member', memberId: memberB });
  const reqComplete = {
    method: 'POST', headers: { cookie: `oheng_session=${sessionB.token}` },
    body: { paymentId }, query: { action: 'complete-payment' },
  };
  const resComplete = makeRes();
  await courseHandler(reqComplete, resComplete);
  assert.equal(resComplete.statusCode, 400, '다른 사람이 만든 결제를 완료 처리하려 하면 거부되어야 함');

  const memberBRecord = await member.getMember(memberB);
  assert.deepEqual(memberBRecord.entitlements || [], [], 'B에게는 절대 수강권이 생기면 안 됨');
});
