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

const DOWNLOAD_POLICIES = ['disabled', 'provider_offline'];

// 드롭박스 앱 폴더 안 videos/ 아래의, 브라우저에서 재생 가능한 확장자만 영상 파일로 인정한다.
const DROPBOX_VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm'];

export function isValidDropboxVideoPath(raw) {
  const path = String(raw || '').trim();
  const lower = path.toLowerCase();
  if (!lower.startsWith('/videos/') || path.includes('..') || path.length > 500) return false;
  return DROPBOX_VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function normalizeDate(raw) {
  const s = String(raw || '').trim();
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00+09:00`)) ? s : '';
}

// 시청 기간은 한국 시간 기준 — Vercel 서버는 UTC로 돌기 때문에 +09:00을 명시해서 계산한다.
// 시작일은 그날 0시부터, 종료일은 그날 23:59:59.999까지 볼 수 있다. 날짜가 없으면 제한 없음.
export function getAvailability(video, now = Date.now()) {
  const from = video?.availableFrom ? Date.parse(`${video.availableFrom}T00:00:00+09:00`) : null;
  const until = video?.availableUntil ? Date.parse(`${video.availableUntil}T23:59:59.999+09:00`) : null;
  if (from !== null && now < from) return 'upcoming';
  if (until !== null && now > until) return 'ended';
  return 'open';
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
    // 기본은 항상 disabled — 'provider_offline'은 콜러스 등 DRM 서비스의 오프라인 재생
    // 기능을 켠다는 뜻이지, 원본 파일을 그냥 내려받게 한다는 뜻이 아니다(Codex 리뷰).
    downloadPolicy: DOWNLOAD_POLICIES.includes(incoming.downloadPolicy) ? incoming.downloadPolicy : 'disabled',
    dropboxPath: isValidDropboxVideoPath(incoming.dropboxPath) ? String(incoming.dropboxPath).trim() : '',
    availableFrom: normalizeDate(incoming.availableFrom),
    availableUntil: normalizeDate(incoming.availableUntil),
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

// note는 관리자 전용 메모, dropboxPath는 재생 주소 발급(playback.js)에만 쓰는 내부 경로 — 학생
// 응답에서는 절대 내려보내지 않는다. 대신 재생 가능 여부(playable)와 시청 기간 상태만 준다.
export async function listVideosForStudent(schoolId, studentId, now = Date.now()) {
  const all = await listAllVideos();
  return all
    .filter(v => canStudentAccessVideo(v, schoolId, studentId))
    .map(({ excludeStudentIds, includeStudentIds, allowSchoolIds, note, dropboxPath, ...rest }) => ({
      ...rest,
      availableFrom: rest.availableFrom || '',
      availableUntil: rest.availableUntil || '',
      playable: !!dropboxPath,
      availability: getAvailability(rest, now),
    }));
}

// 회원이 강좌를 구매해 이 영상에 접근 가능한지 확인.
// course.js가 이 파일의 listAllVideos를 가져다 쓰므로, 순환 import를 피하기 위해
// courses 목록은 이 함수가 직접 조회하지 않고 호출부(course.js)가 미리 조회해서 넘긴다.
export function canMemberAccessVideo(video, member, courses) {
  const now = Date.now();
  const activeCourseIds = new Set(
    (member.entitlements || [])
      .filter(e => e.status === 'active' && new Date(e.expiresAt).getTime() > now)
      .map(e => e.courseId)
  );
  return courses.some(c => activeCourseIds.has(c.id) && (c.videoIds || []).includes(video.id));
}
