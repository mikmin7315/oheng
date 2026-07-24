import { getRedis } from './redis.js';
import { listAllVideos, canMemberAccessVideo } from './video.js';

const COURSE_PREFIX = 'course:';
const COURSE_INDEX_KEY = 'course:index';

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

function normalizeCourse(incoming, existing) {
  return {
    id: existing?.id || incoming.id || ('crs' + Date.now()),
    title: String(incoming.title || '').trim(),
    description: String(incoming.description || '').trim(),
    price: Math.max(0, parseInt(incoming.price, 10) || 0),
    durationDays: Math.max(1, parseInt(incoming.durationDays, 10) || 30),
    videoIds: Array.isArray(incoming.videoIds) ? incoming.videoIds : [],
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
    }));
}

// 회원이 실제 구매(active + 미만료)한 강좌들의 영상 목록.
// /api/videos/mine과 같은 필드 모양(id/title/month/week/mediaKey)에 courseId/courseTitle을 더해
// lecture.html의 기존 렌더링 로직을 재사용하면서 강좌 단위로도 묶을 수 있게 한다.
export async function listVideosForMember(member) {
  const now = Date.now();
  const activeCourseIds = new Set(
    (member.entitlements || [])
      .filter(e => e.status === 'active' && new Date(e.expiresAt).getTime() > now)
      .map(e => e.courseId)
  );
  const courses = await listAllCourses();
  const videos = await listAllVideos();
  const entitledCourses = courses.filter(c => activeCourseIds.has(c.id));
  const accessible = videos.filter(v => canMemberAccessVideo(v, member, courses));
  return accessible.map(v => {
    const owner = entitledCourses.find(c => (c.videoIds || []).includes(v.id));
    return {
      id: v.id, title: v.title, month: v.month, week: v.week, mediaKey: v.mediaKey,
      courseId: owner ? owner.id : null, courseTitle: owner ? owner.title : '',
    };
  });
}
