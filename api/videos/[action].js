import { requireAdminSessionOrApiToken, requireStudentSession, isSameOrigin } from '../_lib/auth.js';
import { listAllVideos, saveVideo, deleteVideo, listVideosForStudent } from '../_lib/video.js';
import { listVideosForEntitlements } from '../_lib/course.js';
import { getOwnerEntitlements, makeStudentOwnerId } from '../_lib/entitlements.js';

// 영상 카탈로그 전용 라우트. 관리자는 전체 목록/등록/수정/삭제, 학생은 본인이 접근 가능한 영상만 조회.
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

  return res.status(404).json({ success: false, message: 'Not found' });
}
