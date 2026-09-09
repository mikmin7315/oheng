import { requireAdminSessionOrApiToken, requireOwnerSession, isSameOrigin } from '../_lib/auth.js';
import { listWatchStatuses, selfConfirmWatch, teacherSetWatchStatus } from '../_lib/watch.js';
import { makeStudentOwnerId } from '../_lib/entitlements.js';

// 영상 단위 시청 기록 전용 라우트. 학생/회원 본인은 자기확인만, 교사(관리자)는 특정
// owner의 특정 영상 상태를 조회/정정할 수 있다.
export default async function handler(req, res) {
  const { action } = req.query;

  // 여러 영상의 내 시청 상태를 한 번에 조회 — 강좌/주차 목록 화면에서 매 영상마다
  // 개별 요청하지 않도록 videoIds를 콤마로 묶어서 받는다.
  if (action === 'mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const videoIds = String(req.query.videoIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoIds.length) return res.status(200).json({ success: true, statuses: {} });
    const statuses = await listWatchStatuses(owner.ownerType, owner.ownerId, videoIds);
    return res.status(200).json({ success: true, statuses });
  }

  // 학생/회원 본인이 "다 봤어요" — 실제 재생 증거는 아니므로 서버가 status를 self_confirmed로
  // 고정해서 저장한다(클라이언트가 다른 status를 주장하지 못하게).
  if (action === 'confirm') {
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

  // 교사(관리자)가 학생 여러 명의 특정 영상 시청 상태를 한 번에 조회 — 학생관리 화면에
  // 붙일 때 학교의 학생 id 목록을 그대로 넘기면 된다.
  if (action === 'admin-list') {
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

  // 교사가 특정 학생의 특정 영상 시청 상태를 직접 지정/정정.
  if (action === 'admin-set') {
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
