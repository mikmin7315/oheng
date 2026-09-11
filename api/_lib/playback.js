import { listVideosForStudent, getVideo, getAvailability } from './video.js';
import { listVideosForEntitlements } from './course.js';
import { getOwnerEntitlements, parseStudentOwnerId } from './entitlements.js';
import { getTemporaryLink } from './dropbox.js';

// "이 사람 목록에 보이는 영상"의 유일한 기준. 학생 목록(mine)과 재생 주소 발급(resolvePlayUrl)이
// 둘 다 이 함수를 쓰므로, 목록에 보이는 영상은 재생되고 안 보이는 영상은 재생되지 않는다.
export async function listVisibleVideosForOwner(owner) {
  const entitlements = await getOwnerEntitlements(owner.ownerType, owner.ownerId);
  const courseVideos = entitlements ? await listVideosForEntitlements(entitlements) : [];
  if (owner.ownerType !== 'student') return courseVideos;
  const { schoolId, studentId } = parseStudentOwnerId(owner.ownerId);
  const schoolVideos = await listVideosForStudent(schoolId, studentId);
  const seen = new Set(schoolVideos.map(v => v.id));
  return schoolVideos.concat(courseVideos.filter(v => !seen.has(v.id)));
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
  } catch {
    return { ok: false, status: 502, message: '영상을 불러오지 못했습니다' };
  }
}
