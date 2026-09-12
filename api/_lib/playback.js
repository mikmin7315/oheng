import { listVideosForStudent, getVideo, getAvailability, canStudentAccessVideo } from './video.js';
import { listVideosForEntitlements } from './course.js';
import { getOwnerEntitlements, parseStudentOwnerId } from './entitlements.js';
import { getTemporaryLink } from './dropbox.js';

// "이 사람 목록에 보이는 영상"의 유일한 기준. 학생 목록(mine)과 재생 주소 발급(resolvePlayUrl)이
// 둘 다 이 함수를 쓰므로, 목록에 보이는 영상은 재생되고 안 보이는 영상은 재생되지 않는다.
export async function listVisibleVideosForOwner(owner) {
  const entitlements = await getOwnerEntitlements(owner.ownerType, owner.ownerId);
  // owner 자체가 더 이상 존재하지 않음(학교/회원 삭제, 또는 학생이 재적 명단에서 빠짐) — 세션은
  // 30일 남아있어도 여기서 즉시 끊어야 탈퇴 후에도 낡은 쿠키로 재생 주소를 받는 걸 막는다.
  if (entitlements === null) return [];
  const courseVideos = entitlements ? await listVideosForEntitlements(entitlements) : [];
  if (owner.ownerType !== 'student') return courseVideos;
  const { schoolId, studentId } = parseStudentOwnerId(owner.ownerId);
  const schoolVideos = await listVideosForStudent(schoolId, studentId);
  const seen = new Set(schoolVideos.map(v => v.id));
  return schoolVideos.concat(courseVideos.filter(v => !seen.has(v.id)));
}

// watch-progress 전용: 목록 전체를 다시 만들지 않고 영상 하나의 가시성만 판정한다.
export async function isVideoVisibleForOwner(owner, videoId) {
  const entitlements = await getOwnerEntitlements(owner.ownerType, owner.ownerId);
  if (entitlements === null) return null;
  const video = await getVideo(videoId);
  if (!video) return null;
  if (owner.ownerType === 'student') {
    const { schoolId, studentId } = parseStudentOwnerId(owner.ownerId);
    if (canStudentAccessVideo(video, schoolId, studentId)) return video;
  }
  if (entitlements) {
    const courseVideos = await listVideosForEntitlements(entitlements);
    if (courseVideos.some(v => v.id === videoId)) return video;
  }
  return null;
}

function koreanDate(ymd) {
  const [, m, d] = String(ymd).split('-');
  return `${Number(m)}월 ${Number(d)}일`;
}

// 재생 주소 발급 판정. 목록에 없는 영상은 403이 아니라 404로 답해 존재 여부를 드러내지 않는다.
// 기간 검사는 화면이 아니라 여기서 한다 — 주소 자체를 안 주는 게 진짜 차단.
export async function resolvePlayUrl(owner, videoId, now = Date.now()) {
  const visible = await listVisibleVideosForOwner(owner);
  if (!visible.some(v => v.id === videoId)) return { ok: false, status: 404, message: '볼 수 없는 영상입니다' };
  const video = await getVideo(videoId);
  if (!video || !video.dropboxPath) return { ok: false, status: 404, message: '아직 영상이 준비되지 않았습니다' };
  const availability = getAvailability(video, now);
  if (availability === 'upcoming') return { ok: false, status: 403, message: `${koreanDate(video.availableFrom)}부터 볼 수 있어요` };
  if (availability === 'ended') return { ok: false, status: 403, message: '시청 기간이 끝났어요' };
  try {
    const url = await getTemporaryLink(video.dropboxPath);
    return { ok: true, url };
  } catch (e) {
    console.error('[dropbox] play-url failed:', e.message, e.detail || '');
    return { ok: false, status: 502, message: '영상을 불러오지 못했습니다' };
  }
}
