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
  assert.equal(video.isValidDropboxVideoPath('/videos/1강..최종.mp4'), true, '파일명에 ..이 들어가도 허용');
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
