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
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) { const existed = store.has(key); store.delete(key); return existed ? 1 : 0; },
    async incr(key) { const v = (store.get(key) || 0) + 1; store.set(key, v); return v; },
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
  assert.equal(res.body.member.entitlements[0].status, 'active');

  const remaining = await course.listApplicants(live.id);
  assert.ok(!remaining.some(a => a.memberId === memberId), '수강권 부여 후 신청자 목록에서 빠져야 함');

  const updatedMember = await member.getMember(memberId);
  const videos = await course.listVideosForMember(updatedMember);
  assert.deepEqual(videos.map(v => v.id), ['v1', 'v2', 'v3'], '회원 영상 목록은 course.videoIds 순서를 따라야 함(전체 영상 목록 순서 아님)');
  assert.equal(videos[0].courseTitle, '순서 테스트 강좌');
});
