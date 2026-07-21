import { requireAdminSessionOrApiToken, requireMemberSession, isSameOrigin } from '../_lib/auth.js';
import { getMember, updateMemberEntitlements } from '../_lib/member.js';
import {
  listAllCourses, getCourse, saveCourse, deleteCourse,
  listPublishedCoursesForPublic, listVideosForMember,
} from '../_lib/course.js';

export default async function handler(req, res) {
  const { action } = req.query;

  if (action === 'list') {
    if (req.method !== 'GET') return res.status(405).end();
    const courses = await listPublishedCoursesForPublic();
    return res.status(200).json({ success: true, courses });
  }

  if (action === 'mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const session = await requireMemberSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const member = await getMember(session.memberId);
    if (!member) return res.status(404).json({ success: false, message: '회원 정보를 찾을 수 없습니다' });
    const videos = await listVideosForMember(member);
    return res.status(200).json({ success: true, videos });
  }

  const admin = await requireAdminSessionOrApiToken(req);
  if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (action === 'admin-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const courses = await listAllCourses();
    return res.status(200).json({ success: true, courses });
  }

  if (action === 'save') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { title } = req.body || {};
    if (!String(title || '').trim()) return res.status(400).json({ success: false, message: '제목을 입력하세요' });
    const course = await saveCourse(req.body || {});
    return res.status(200).json({ success: true, course });
  }

  if (action === 'delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
    await deleteCourse(id);
    return res.status(200).json({ success: true });
  }

  // 결제 연동 전까지, 현금 결제/이벤트/QA 목적으로 관리자가 수강권을 직접 부여한다.
  if (action === 'grant-entitlement') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { memberId, courseId, days } = req.body || {};
    if (!memberId || !courseId) return res.status(400).json({ success: false, message: 'Missing memberId/courseId' });
    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ success: false, message: '회원을 찾을 수 없습니다' });
    const course = await getCourse(courseId);
    if (!course) return res.status(404).json({ success: false, message: '강좌를 찾을 수 없습니다' });
    const durationDays = Math.max(1, parseInt(days, 10) || course.durationDays || 30);
    const expiresAt = new Date(Date.now() + durationDays * 86400000).toISOString();
    const entitlements = (member.entitlements || []).filter(e => e.courseId !== courseId);
    entitlements.push({
      courseId, purchasedAt: new Date().toISOString(), expiresAt,
      paymentId: 'manual', amount: 0, status: 'active',
    });
    const updated = await updateMemberEntitlements(memberId, entitlements);
    return res.status(200).json({ success: true, member: updated });
  }

  // 환불/취소 시 관리자가 수강권을 회수한다(설계 문서: 자동 환불은 범위 밖, 수동 처리).
  if (action === 'revoke-entitlement') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { memberId, courseId } = req.body || {};
    if (!memberId || !courseId) return res.status(400).json({ success: false, message: 'Missing memberId/courseId' });
    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ success: false, message: '회원을 찾을 수 없습니다' });
    const entitlements = (member.entitlements || []).map(e =>
      e.courseId === courseId ? { ...e, status: 'revoked' } : e);
    const updated = await updateMemberEntitlements(memberId, entitlements);
    return res.status(200).json({ success: true, member: updated });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
