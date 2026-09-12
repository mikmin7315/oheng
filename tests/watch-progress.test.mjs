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
const fakeRedis = makeFakeRedis();
before(() => { mock.module('../api/_lib/redis.js', { namedExports: { getRedis: () => fakeRedis } }); });
const watch = await import('../api/_lib/watch.js');

test('mergeSegments: 정렬·겹침 병합·범위 밖 잘라내기·잘못된 항목 무시', () => {
  const merged = watch.mergeSegments([[30, 45], [0, 10], [8, 20], [-5, 3], [590, 700], ['x', 5], [50, 50]], 600);
  assert.deepEqual(merged, [[0, 20], [30, 45], [590, 600]]);
  assert.equal(watch.sumSegments(merged), 20 + 15 + 10);
});

test('recordProgress: 구간을 누적 병합하고 시청 시간은 서버가 다시 계산한다', async () => {
  const t0 = Date.parse('2026-09-12T10:00:00Z');
  const r1 = await watch.recordProgress('student', 'sch:stu', 'v1', { durationSec: 100, segments: [[0, 30]], lastPositionSec: 30, watchedSec: 999 }, t0);
  assert.equal(r1.progress.watchedSec, 30);
  assert.equal(r1.progress.ratio, 0.3);
  assert.equal(r1.status, 'opened');
  assert.equal(r1.progress.lastPositionSec, 30);
  const r2 = await watch.recordProgress('student', 'sch:stu', 'v1', { durationSec: 100, segments: [[20, 50]], lastPositionSec: 50 }, t0 + 25000);
  assert.deepEqual(r2.progress.segments, [[0, 50]]);
  assert.equal(r2.progress.watchedSec, 50);
  assert.equal(r2.progress.firstAt, r1.progress.firstAt);
});

test('recordProgress: 90% 이상이면 auto_completed/player, 미만이면 유지', async () => {
  const t0 = Date.parse('2026-09-12T11:00:00Z');
  const a = await watch.recordProgress('student', 'sch:stu', 'v2', { durationSec: 100, segments: [[0, 89]] }, t0);
  assert.equal(a.status, 'opened');
  const b = await watch.recordProgress('student', 'sch:stu', 'v2', { durationSec: 100, segments: [[89, 90]] }, t0 + 5000);
  assert.equal(b.status, 'auto_completed');
  assert.equal(b.source, 'player');
  assert.ok(b.completedAt);
});

test('recordProgress: 건너뛴 구간은 세지 않는다 (끝으로 점프해도 완료 아님)', async () => {
  const r = await watch.recordProgress('student', 'sch:stu', 'v3', { durationSec: 600, segments: [[0, 10], [590, 600]] }, Date.now());
  assert.equal(r.progress.watchedSec, 20);
  assert.equal(r.status, 'opened');
});

test('recordProgress: 선생님 정정 이후의 자동 기록은 status/source를 바꾸지 않는다', async () => {
  await watch.teacherSetWatchStatus('student', 'sch:stu', 'v4', 'exempt', '오은실');
  const r = await watch.recordProgress('student', 'sch:stu', 'v4', { durationSec: 100, segments: [[0, 100]] }, Date.now());
  assert.equal(r.status, 'exempt');
  assert.equal(r.source, 'teacher');
  assert.equal(r.setBy, '오은실');
  assert.equal(r.progress.ratio, 1);
});

test('teacherSetWatchStatus: 기존 progress를 지우지 않는다', async () => {
  await watch.recordProgress('student', 'sch:stu', 'v5', { durationSec: 100, segments: [[0, 40]] }, Date.now());
  const r = await watch.teacherSetWatchStatus('student', 'sch:stu', 'v5', 'teacher_confirmed', '오은실');
  assert.equal(r.status, 'teacher_confirmed');
  assert.equal(r.progress.watchedSec, 40);
});

test('recordProgress: 너무 빠른 증가는 fast_progress 플래그 (저장은 함)', async () => {
  const t0 = Date.parse('2026-09-12T12:00:00Z');
  await watch.recordProgress('student', 'sch:stu', 'v6', { durationSec: 3600, segments: [[0, 10]] }, t0);
  const r = await watch.recordProgress('student', 'sch:stu', 'v6', { durationSec: 3600, segments: [[10, 2000]] }, t0 + 10000);
  assert.ok(r.progress.flags.includes('fast_progress'));
  assert.equal(r.progress.watchedSec, 2000);
  const ok = await watch.recordProgress('student', 'sch:stu', 'v7', { durationSec: 3600, segments: [[0, 10]] }, t0);
  const ok2 = await watch.recordProgress('student', 'sch:stu', 'v7', { durationSec: 3600, segments: [[10, 40]] }, t0 + 15000);
  assert.deepEqual(ok2.progress.flags, []);
  void ok;
});

test('recordProgress: 잘못된 길이·구간은 BAD_INPUT', async () => {
  for (const bad of [
    { durationSec: 0, segments: [[0, 1]] },
    { durationSec: 99999, segments: [[0, 1]] },
    { durationSec: 100, segments: 'nope' },
    { durationSec: 100, segments: Array.from({ length: 401 }, (_, i) => [i, i + 1]) },
  ]) {
    await assert.rejects(() => watch.recordProgress('student', 'sch:stu', 'v8', bad), e => e.code === 'BAD_INPUT');
  }
});
