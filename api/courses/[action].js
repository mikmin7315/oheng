import { requireAdminSessionOrApiToken, requireMemberSession, isSameOrigin } from '../_lib/auth.js';
import { getMember, updateMemberEntitlements } from '../_lib/member.js';
import {
  listAllCourses, getCourse, saveCourse, deleteCourse,
  listPublishedCoursesForPublic, listVideosForMember,
  applyToCourse, listApplicants, removeApplicant,
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

  // 결제 연동 전 임시 흐름 — 회원이 강좌 카드에서 "신청하기"를 누르면 관리자 대기열에 쌓이고,
  // 관리자가 강좌 관리 화면에서 확인 후 수동으로 수강권을 부여한다.
  if (action === 'apply') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const session = await requireMemberSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { courseId } = req.body || {};
    if (!courseId) return res.status(400).json({ success: false, message: 'Missing courseId' });
    const course = await getCourse(courseId);
    if (!course || !course.published) return res.status(404).json({ success: false, message: '강좌를 찾을 수 없습니다' });
    await applyToCourse(courseId, session.memberId);
    return res.status(200).json({ success: true });
  }

  const admin = await requireAdminSessionOrApiToken(req);
  if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (action === 'admin-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const courses = await listAllCourses();
    return res.status(200).json({ success: true, courses });
  }

  // 강좌별 신청자 목록 — 회원 이름/연락처를 같이 붙여서 관리자가 바로 확인/부여할 수 있게 한다.
  if (action === 'admin-applicants') {
    if (req.method !== 'GET') return res.status(405).end();
    const courseId = String(req.query.courseId || '');
    if (!courseId) return res.status(400).json({ success: false, message: 'Missing courseId' });
    const applicants = await listApplicants(courseId);
    const members = await Promise.all(applicants.map(a => getMember(a.memberId)));
    const merged = applicants.map((a, i) => {
      const m = members[i];
      return {
        memberId: a.memberId, appliedAt: a.appliedAt,
        name: m?.name || '(탈퇴/알 수 없음)', phone: m?.phone || '', email: m?.email || '',
      };
    }).sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt));
    return res.status(200).json({ success: true, applicants: merged });
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
    await removeApplicant(courseId, memberId);
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
