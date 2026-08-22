import { getRedis } from './redis.js';
import { listAllVideos } from './video.js';

const COURSE_PREFIX = 'course:';
const COURSE_INDEX_KEY = 'course:index';
const APPLICANTS_PREFIX = 'course:applicants:';

export async function getCourseIndex() {
  const redis = getRedis();
  const idx = await redis.get(COURSE_INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

export async function getCourse(id) {
  const redis = getRedis();
  return await redis.get(COURSE_PREFIX + id);
}

export async function listAllCourses() {
  const index = await getCourseIndex();
  const courses = await Promise.all(index.map(id => getCourse(id)));
  return courses.filter(Boolean);
}

const COURSE_LEVELS = ['초등', '중등', '고등/수능', '특강'];

// CSS background:url(...)에 그대로 들어가므로 http(s) 스킴만 허용 — data:/javascript: 등 차단.
function sanitizeThumbnailUrl(raw) {
  const url = String(raw || '').trim().slice(0, 500);
  return /^https?:\/\//i.test(url) ? url : '';
}

function normalizeCourse(incoming, existing) {
  return {
    id: existing?.id || incoming.id || ('crs' + Date.now()),
    title: String(incoming.title || '').trim(),
    description: String(incoming.description || '').trim(),
    price: Math.max(0, parseInt(incoming.price, 10) || 0),
    durationDays: Math.max(1, parseInt(incoming.durationDays, 10) || 30),
    videoIds: Array.isArray(incoming.videoIds) ? incoming.videoIds : [],
    level: COURSE_LEVELS.includes(incoming.level) ? incoming.level : '',
    thumbnailUrl: sanitizeThumbnailUrl(incoming.thumbnailUrl),
    published: !!incoming.published,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function saveCourse(incoming) {
  const redis = getRedis();
  const existing = incoming.id ? await getCourse(incoming.id) : null;
  const course = normalizeCourse(incoming, existing);
  await redis.set(COURSE_PREFIX + course.id, course);
  if (!existing) {
    const index = await getCourseIndex();
    if (!index.includes(course.id)) {
      index.push(course.id);
      await redis.set(COURSE_INDEX_KEY, index);
    }
  }
  return course;
}

export async function deleteCourse(id) {
  const redis = getRedis();
  await redis.del(COURSE_PREFIX + id);
  const index = await getCourseIndex();
  await redis.set(COURSE_INDEX_KEY, index.filter(x => x !== id));
}

// 비로그인 둘러보기용 — published인 것만, 공개 가능한 필드만(관리자 전용 필드 제외)
export async function listPublishedCoursesForPublic() {
  const all = await listAllCourses();
  return all
    .filter(c => c.published)
    .map(c => ({
      id: c.id, title: c.title, description: c.description,
      price: c.price, durationDays: c.durationDays, videoCount: (c.videoIds || []).length,
      level: c.level || '', thumbnailUrl: c.thumbnailUrl || '',
    }));
}

// 결제 연동 전까지, 강좌 카드의 "신청하기"가 여기 쌓인다 — 관리자가 강좌 관리 화면에서
// 신청자 목록을 보고 수동으로 수강권을 부여(grant-entitlement)하면 명단에서 빠진다.
// memberId 기준으로 중복 신청은 최신 시각으로만 갱신(같은 사람이 여러 번 눌러도 한 줄).
export async function applyToCourse(courseId, memberId) {
  const redis = getRedis();
  const key = APPLICANTS_PREFIX + courseId;
  const list = (await redis.get(key)) || [];
  const filtered = list.filter(a => a.memberId !== memberId);
  filtered.push({ memberId, appliedAt: new Date().toISOString() });
  await redis.set(key, filtered);
}

export async function listApplicants(courseId) {
  const redis = getRedis();
  return (await redis.get(APPLICANTS_PREFIX + courseId)) || [];
}

export async function removeApplicant(courseId, memberId) {
  const redis = getRedis();
  const key = APPLICANTS_PREFIX + courseId;
  const list = (await redis.get(key)) || [];
  await redis.set(key, list.filter(a => a.memberId !== memberId));
}

// 회원이 실제 구매(active + 미만료)한 강좌들의 영상 목록.
// /api/videos/mine과 같은 필드 모양(id/title/month/week/mediaKey)에 courseId/courseTitle을 더해
// lecture.html의 기존 렌더링 로직을 재사용하면서 강좌 단위로도 묶을 수 있게 한다.
// course.videoIds 배열 순서(관리자가 강좌 관리에서 ▲▼로 지정한 재생 순서) 그대로 반환 —
// listAllVideos() 전체 목록 순서를 쓰면 관리자가 지정한 순서가 무시되므로 주의.
export async function listVideosForMember(member) {
  const now = Date.now();
  const activeCourseIds = new Set(
    (member.entitlements || [])
      .filter(e => e.status === 'active' && new Date(e.expiresAt).getTime() > now)
      .map(e => e.courseId)
  );
  const courses = await listAllCourses();
  const videos = await listAllVideos();
  const videoById = new Map(videos.map(v => [v.id, v]));
  const entitledCourses = courses.filter(c => activeCourseIds.has(c.id));
  const seen = new Set();
  const result = [];
  for (const course of entitledCourses) {
    for (const vid of course.videoIds || []) {
      if (seen.has(vid)) continue;
      const v = videoById.get(vid);
      if (!v) continue;
      seen.add(vid);
      result.push({
        id: v.id, title: v.title, month: v.month, week: v.week, mediaKey: v.mediaKey,
        courseId: course.id, courseTitle: course.title,
      });
    }
  }
  return result;
}
