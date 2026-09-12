import { getRedis } from './redis.js';

// 영상 단위 시청 기록 — 기존 attendType(주단위, 교사가 수동 입력하는 출석 체크)과는 별개.
// 재생 인프라(콜러스든 LearnEx든 자체 플레이어든)에 의존하지 않는 값만 쓴다: 지금은
// "학생 자기확인"과 "교사 정정"만 있고, 나중에 실제 재생 이벤트를 붙이면 source:'proxy'
// 또는 'kollus'로 같은 레코드 모양에 자동 기록하면 된다(Codex 설계 리뷰 반영).
//
// status: 'opened' | 'self_confirmed'(옛 자기확인, 더 이상 생성 안 함) | 'auto_completed' | 'teacher_confirmed' | 'exempt'
// source: 'student' | 'player' | 'teacher' (누가 이 상태를 만들었는지 — 화면에 "학생 확인"과
//         "선생님 확인"을 구분해서 보여줘야 하므로 절대 하나로 뭉치지 않는다)

// 자동 시청 기록. 재생기가 보낸 "실제 재생한 구간"을 서버가 병합·재계산한다 — 클라이언트가 보낸
// 합계는 믿지 않는다. 90% 이상이면 auto_completed. 선생님이 정정한 값(source:'teacher')은 절대 덮지
// 않는다(Codex 검토 반영). 이 기록은 "재생기 기준"일 뿐 실제로 보고 들었다는 증명이 아니다.
export const WATCH_COMPLETE_RATIO = 0.9;
const MAX_DURATION_SEC = 21600;
const MAX_SEGMENTS = 400;

export function mergeSegments(segments, durationSec) {
  const clean = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!Array.isArray(seg) || seg.length !== 2) continue;
    let s = Math.floor(Number(seg[0]));
    let e = Math.ceil(Number(seg[1]));
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    s = Math.max(0, s);
    e = Math.min(durationSec, e);
    if (e > s) clean.push([s, e]);
  }
  clean.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of clean) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

export function sumSegments(segments) {
  return (segments || []).reduce((acc, [s, e]) => acc + (e - s), 0);
}

function badInput(message) {
  const err = new Error(message);
  err.code = 'BAD_INPUT';
  return err;
}

export async function recordProgress(ownerType, ownerId, videoId, input, now = Date.now()) {
  const durationSec = Math.floor(Number(input?.durationSec));
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_DURATION_SEC) throw badInput('영상 길이가 올바르지 않습니다');
  const incoming = input?.segments;
  if (!Array.isArray(incoming) || incoming.length > MAX_SEGMENTS) throw badInput('재생 구간이 올바르지 않습니다');

  const redis = getRedis();
  const key = watchKey(ownerType, ownerId, videoId);
  const existing = await redis.get(key);
  const prev = existing?.progress || null;
  const segments = mergeSegments([...(prev?.segments || []), ...incoming], durationSec).slice(0, MAX_SEGMENTS);
  const watchedSec = sumSegments(segments);
  const ratio = Math.min(1, Math.round((watchedSec / durationSec) * 100) / 100);

  // 증가 속도 검사 — 2배속 재생 + 시계 오차를 넘는 증가는 의심 표시만 하고 저장은 한다(정상 기록을 잃지 않게).
  const flags = new Set(prev?.flags || []);
  if (prev) {
    const elapsedSec = Math.max(0, (now - Date.parse(prev.updatedAt)) / 1000);
    if (watchedSec - (prev.watchedSec || 0) > elapsedSec * 2.5 + 30) flags.add('fast_progress');
  }

  const nowIso = new Date(now).toISOString();
  const lastPositionSec = Math.min(durationSec, Math.max(0, Math.floor(Number(input?.lastPositionSec)) || 0));
  const progress = { durationSec, segments, watchedSec, ratio, lastPositionSec, flags: [...flags], firstAt: prev?.firstAt || nowIso, updatedAt: nowIso };

  const teacherSet = existing?.source === 'teacher';
  const completed = ratio >= WATCH_COMPLETE_RATIO;
  const record = {
    ownerType, ownerId, videoId,
    status: teacherSet ? existing.status : (completed ? 'auto_completed' : (existing?.status || 'opened')),
    source: teacherSet ? 'teacher' : (completed ? 'player' : (existing?.source || 'player')),
    firstOpenedAt: existing?.firstOpenedAt || nowIso,
    completedAt: teacherSet ? (existing.completedAt || null)
      : (completed ? (existing?.status === 'auto_completed' ? existing.completedAt : nowIso) : (existing?.completedAt || null)),
    updatedAt: nowIso,
    history: existing?.history || [],
    ...(existing?.setBy ? { setBy: existing.setBy } : {}),
    progress,
  };
  await redis.set(key, record);
  return record;
}

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
    progress: existing?.progress || null,
  };
  await redis.set(key, record);
  return record;
}
