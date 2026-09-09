import { getRedis } from './redis.js';

// 영상 단위 시청 기록 — 기존 attendType(주단위, 교사가 수동 입력하는 출석 체크)과는 별개.
// 재생 인프라(콜러스든 LearnEx든 자체 플레이어든)에 의존하지 않는 값만 쓴다: 지금은
// "학생 자기확인"과 "교사 정정"만 있고, 나중에 실제 재생 이벤트를 붙이면 source:'proxy'
// 또는 'kollus'로 같은 레코드 모양에 자동 기록하면 된다(Codex 설계 리뷰 반영).
//
// status: 'opened' | 'self_confirmed' | 'teacher_confirmed' | 'exempt'
// source: 'student' | 'teacher' (누가 이 상태를 만들었는지 — 화면에 "학생 확인"과
//         "선생님 확인"을 구분해서 보여줘야 하므로 절대 하나로 뭉치지 않는다)
function watchKey(ownerType, ownerId, videoId) {
  return `watch:${ownerType}:${ownerId}:${videoId}`;
}

export async function getWatchStatus(ownerType, ownerId, videoId) {
  const redis = getRedis();
  return await redis.get(watchKey(ownerType, ownerId, videoId));
}

// 여러 영상의 상태를 한 번에 — 강좌/주차 화면에서 영상 목록 렌더할 때 매번 개별 조회하지 않게.
export async function listWatchStatuses(ownerType, ownerId, videoIds) {
  const redis = getRedis();
  const results = await Promise.all(videoIds.map(id => redis.get(watchKey(ownerType, ownerId, id))));
  const map = {};
  videoIds.forEach((id, i) => { if (results[i]) map[id] = results[i]; });
  return map;
}

// 학생/회원 본인이 "다 봤어요"를 누른 경우 — 실제 재생 증거는 아니므로 화면에는 반드시
// "학생 확인"이라고 표시할 것(교사가 실제 시청으로 오해하지 않게).
export async function selfConfirmWatch(ownerType, ownerId, videoId) {
  const redis = getRedis();
  const key = watchKey(ownerType, ownerId, videoId);
  const existing = await redis.get(key);
  const now = new Date().toISOString();
  const record = {
    ownerType, ownerId, videoId,
    status: 'self_confirmed',
    source: 'student',
    firstOpenedAt: existing?.firstOpenedAt || now,
    completedAt: now,
    updatedAt: now,
    history: existing?.history || [],
  };
  await redis.set(key, record);
  return record;
}

// 교사가 학생별 시청 상태를 직접 지정/정정 — 이전 값을 history에 감사기록으로 남긴다.
export async function teacherSetWatchStatus(ownerType, ownerId, videoId, status, teacherName) {
  const redis = getRedis();
  const key = watchKey(ownerType, ownerId, videoId);
  const existing = await redis.get(key);
  const now = new Date().toISOString();
  const history = existing
    ? [...(existing.history || []), { prevStatus: existing.status, prevSource: existing.source, changedBy: teacherName, changedAt: now }]
    : (existing?.history || []);
  const record = {
    ownerType, ownerId, videoId,
    status, // 'teacher_confirmed' | 'exempt' | 'opened'
    source: 'teacher',
    firstOpenedAt: existing?.firstOpenedAt || null,
    completedAt: (status === 'teacher_confirmed') ? now : (existing?.completedAt || null),
    updatedAt: now,
    history,
    setBy: teacherName,
  };
  await redis.set(key, record);
  return record;
}
