import { requireAdminSessionOrApiToken, requireStudentSession, requireOwnerSession, isSameOrigin } from '../_lib/auth.js';
import { listAllVideos, saveVideo, deleteVideo, listVideosForStudent } from '../_lib/video.js';
import { listVideosForEntitlements } from '../_lib/course.js';
import { getOwnerEntitlements, makeStudentOwnerId } from '../_lib/entitlements.js';
import { listWatchStatuses, selfConfirmWatch, teacherSetWatchStatus } from '../_lib/watch.js';

// 영상 카탈로그 + 시청기록 라우트. Vercel Hobby 플랜의 서버리스 함수 12개 제한 때문에
// 시청기록(watch-*)을 별도 파일로 안 빼고 이 파일에 합쳐뒀다.
// 관리자는 전체 목록/등록/수정/삭제, 학생은 본인이 접근 가능한 영상만 조회.
export default async function handler(req, res) {
  const { action } = req.query;

  if (action === 'mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const session = await requireStudentSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    // 학교가 배정한 영상 + 학생 본인이 직접 구매한 유료 강좌 영상을 합쳐서 보여준다.
    const schoolVideos = await listVideosForStudent(session.schoolId, session.studentId);
    const ownerId = makeStudentOwnerId(session.schoolId, session.studentId);
    const entitlements = await getOwnerEntitlements('student', ownerId);
    const courseVideos = entitlements ? await listVideosForEntitlements(entitlements) : [];
    const seen = new Set(schoolVideos.map(v => v.id));
    const videos = schoolVideos.concat(courseVideos.filter(v => !seen.has(v.id)));
    return res.status(200).json({ success: true, videos });
  }

  // 여러 영상의 내 시청 상태를 한 번에 조회 — 회원/학생 둘 다.
  if (action === 'watch-mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const videoIds = String(req.query.videoIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoIds.length) return res.status(200).json({ success: true, statuses: {} });
    const statuses = await listWatchStatuses(owner.ownerType, owner.ownerId, videoIds);
    return res.status(200).json({ success: true, statuses });
  }

  // 학생/회원 본인이 "다 봤어요" — 실제 재생 증거는 아니므로 서버가 status를 고정해서 저장.
  if (action === 'watch-confirm') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { videoId } = req.body || {};
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    const record = await selfConfirmWatch(owner.ownerType, owner.ownerId, videoId);
    return res.status(200).json({ success: true, record });
  }

  const admin = await requireAdminSessionOrApiToken(req);
  if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (action === 'list') {
    if (req.method !== 'GET') return res.status(405).end();
    const videos = await listAllVideos();
    return res.status(200).json({ success: true, videos });
  }

  if (action === 'save') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { title } = req.body || {};
    if (!String(title || '').trim()) return res.status(400).json({ success: false, message: '제목을 입력하세요' });
    const video = await saveVideo(req.body || {});
    return res.status(200).json({ success: true, video });
  }

  if (action === 'delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
    await deleteVideo(id);
    return res.status(200).json({ success: true });
  }

  // 교사(관리자)가 학생 여러 명의 특정 영상 시청 상태를 한 번에 조회.
  if (action === 'watch-admin-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const videoId = String(req.query.videoId || '');
    const schoolId = String(req.query.schoolId || '');
    const studentIds = String(req.query.studentIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoId || !schoolId || !studentIds.length) {
      return res.status(400).json({ success: false, message: 'Missing videoId/schoolId/studentIds' });
    }
    const entries = await Promise.all(studentIds.map(async sid => {
      const ownerId = makeStudentOwnerId(schoolId, sid);
      const [status] = Object.values(await listWatchStatuses('student', ownerId, [videoId]));
      return [sid, status || null];
    }));
    return res.status(200).json({ success: true, statuses: Object.fromEntries(entries) });
  }

  // 교사가 특정 학생/회원의 특정 영상 시청 상태를 직접 지정/정정.
  if (action === 'watch-admin-set') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { ownerType, memberId, schoolId, studentId, videoId, status } = req.body || {};
    if (!videoId || !status) return res.status(400).json({ success: false, message: 'Missing videoId/status' });
    if (!['teacher_confirmed', 'exempt', 'opened'].includes(status)) {
      return res.status(400).json({ success: false, message: '허용되지 않은 status' });
    }
    let resolvedType, resolvedId;
    if (ownerType === 'member' || memberId) { resolvedType = 'member'; resolvedId = memberId; }
    else if (schoolId && studentId) { resolvedType = 'student'; resolvedId = makeStudentOwnerId(schoolId, studentId); }
    if (!resolvedType || !resolvedId) return res.status(400).json({ success: false, message: 'Missing owner 정보' });
    const record = await teacherSetWatchStatus(resolvedType, resolvedId, videoId, status, admin.actorName || admin.actorId || 'admin');
    return res.status(200).json({ success: true, record });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
