import { getRedis } from './redis.js';

const VIDEO_PREFIX = 'video:';
const VIDEO_INDEX_KEY = 'video:index';

// 영상은 여러 학교에서 공유될 수 있어 학교 blob과 별도로 전역 카탈로그로 관리한다.
// mediaKey는 콜러스(Kollus) 미디어 콘텐츠 키 — 콜러스 계정 연동 전까지는 관리자가 임시로 빈 값/플레이스홀더로 둘 수 있음.
export async function getVideoIndex() {
  const redis = getRedis();
  const idx = await redis.get(VIDEO_INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

export async function getVideo(id) {
  const redis = getRedis();
  return await redis.get(VIDEO_PREFIX + id);
}

export async function listAllVideos() {
  const index = await getVideoIndex();
  const videos = await Promise.all(index.map(id => getVideo(id)));
  return videos.filter(Boolean);
}

function normalizeVideo(incoming, existing) {
  return {
    id: existing?.id || incoming.id || ('vid' + Date.now()),
    title: String(incoming.title || '').trim(),
    month: incoming.month || '',
    week: incoming.week || '',
    mediaKey: String(incoming.mediaKey || '').trim(),
    note: String(incoming.note || '').trim(),
    allowSchoolIds: Array.isArray(incoming.allowSchoolIds) ? incoming.allowSchoolIds : [],
    excludeStudentIds: Array.isArray(incoming.excludeStudentIds) ? incoming.excludeStudentIds : [],
    includeStudentIds: Array.isArray(incoming.includeStudentIds) ? incoming.includeStudentIds : [],
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function saveVideo(incoming) {
  const redis = getRedis();
  const existing = incoming.id ? await getVideo(incoming.id) : null;
  const video = normalizeVideo(incoming, existing);
  await redis.set(VIDEO_PREFIX + video.id, video);
  if (!existing) {
    const index = await getVideoIndex();
    if (!index.includes(video.id)) {
      index.push(video.id);
      await redis.set(VIDEO_INDEX_KEY, index);
    }
  }
  return video;
}

export async function deleteVideo(id) {
  const redis = getRedis();
  await redis.del(VIDEO_PREFIX + id);
  const index = await getVideoIndex();
  await redis.set(VIDEO_INDEX_KEY, index.filter(x => x !== id));
}

// 학교 기본 허용 목록에 있으면 보이되, 개별 학생 예외(차단/추가 허용)가 우선한다.
export function canStudentAccessVideo(video, schoolId, studentId) {
  if ((video.excludeStudentIds || []).includes(studentId)) return false;
  if ((video.includeStudentIds || []).includes(studentId)) return true;
  return (video.allowSchoolIds || []).includes(schoolId);
}

export async function listVideosForStudent(schoolId, studentId) {
  const all = await listAllVideos();
  return all
    .filter(v => canStudentAccessVideo(v, schoolId, studentId))
    .map(({ excludeStudentIds, includeStudentIds, allowSchoolIds, ...rest }) => rest);
}
