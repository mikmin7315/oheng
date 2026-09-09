import { requireAdminSessionOrApiToken, requireMemberSession, requireOwnerSession, isSameOrigin } from '../_lib/auth.js';
import { getMember } from '../_lib/member.js';
import {
  listAllCourses, getCourse, saveCourse, deleteCourse,
  listPublishedCoursesForPublic, listVideosForEntitlements,
  applyToCourse, listApplicants, removeApplicant,
} from '../_lib/course.js';
import { createPendingPayment, verifyAndCompletePayment } from '../_lib/payment.js';
import { getOwnerEntitlements, setOwnerEntitlements, makeStudentOwnerId, parseStudentOwnerId } from '../_lib/entitlements.js';
import { getSchool } from '../_lib/school.js';
import {
  listReviewsForPublic, createReview, deleteReview, addComment, deleteComment,
} from '../_lib/review.js';
import { uploadReviewImage } from '../_lib/dropbox.js';

// 후기 이미지는 base64로 JSON body에 실려오므로(파일당 5MB 이하 기준 base64로는 약 6.7MB),
// 기본 바디 크기 제한을 넉넉히 올려둔다. 이 파일의 다른 액션들은 JSON이 작아 영향 없음.
export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

// 후기/댓글 작성 주체 확인 — 선생님(관리자 세션 또는 API 토큰) 또는 학생 세션만 허용.
// 일반 회원(member)의 후기 작성은 이번 스펙 범위 밖(설계 문서 "범위 밖" 참고).
async function requireReviewAuthor(req, admin) {
  if (admin) {
    return { authorType: 'teacher', authorName: admin.actorName || admin.actorId || '오은실 대표강사', ownerId: null };
  }
  const owner = await requireOwnerSession(req);
  if (!owner || owner.ownerType !== 'student') return null;
  const { schoolId, studentId } = parseStudentOwnerId(owner.ownerId);
  const sc = schoolId ? await getSchool(schoolId) : null;
  const student = sc ? (sc.students || []).find(s => s.id === studentId) : null;
  return { authorType: 'student', authorName: student?.name || '학생', ownerId: owner.ownerId };
}

export default async function handler(req, res) {
  const { action } = req.query;

  // 후기 게시판 — 비로그인 방문자도 조회 가능(마케팅 사이트 신뢰도 목적).
  if (action === 'review-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const reviews = await listReviewsForPublic();
    return res.status(200).json({ success: true, reviews });
  }

  if (action === 'list') {
    if (req.method !== 'GET') return res.status(405).end();
    const courses = await listPublishedCoursesForPublic();
    return res.status(200).json({ success: true, courses });
  }

  // 내가 구매한 강좌의 영상 목록 — 회원이든(휴대폰/구글) 학생이든(학교ID/비번) 로그인만
  // 되어있으면 된다. lecture.html의 회원 화면과 학생 "인강 시청" 화면 둘 다 이 액션을 쓴다.
  if (action === 'mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const entitlements = await getOwnerEntitlements(owner.ownerType, owner.ownerId);
    if (entitlements === null) return res.status(404).json({ success: false, message: '정보를 찾을 수 없습니다' });
    const videos = await listVideosForEntitlements(entitlements);
    return res.status(200).json({ success: true, videos });
  }

  // 결제 연동 전 임시 흐름 — 회원이 강좌 카드에서 "신청하기"를 누르면 관리자 대기열에 쌓이고,
  // 관리자가 강좌 관리 화면에서 확인 후 수동으로 수강권을 부여한다. (무료 강좌 전용, 회원만 해당)
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

  // 후기 작성 — 관리자(선생님) 또는 학생 로그인 필요. 승인 절차 없이 즉시 공개되므로
  // 스팸 방지 목적으로 비로그인 작성은 막는다(설계 문서 "안전장치" 참고).
  if (action === 'review-create') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const admin = await requireAdminSessionOrApiToken(req);
    const author = await requireReviewAuthor(req, admin);
    if (!author) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { text, images } = req.body || {};
    try {
      const review = await createReview({ ...author, text, images });
      return res.status(200).json({ success: true, review });
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message || '후기 작성에 실패했습니다' });
    }
  }

  // 후기 이미지 업로드 — 후기 작성 폼에서 이미지를 고르면 먼저 이 액션으로 하나씩 올려
  // URL을 받고, 그 URL들을 모아 review-create를 호출한다.
  if (action === 'review-image-upload') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const admin = await requireAdminSessionOrApiToken(req);
    const author = await requireReviewAuthor(req, admin);
    if (!author) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { filename, mimeType, dataBase64 } = req.body || {};
    if (!dataBase64) return res.status(400).json({ success: false, message: 'Missing dataBase64' });
    try {
      const url = await uploadReviewImage(dataBase64, filename, mimeType);
      return res.status(200).json({ success: true, url });
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message || '이미지 업로드에 실패했습니다' });
    }
  }

  // 댓글 작성 — 후기 작성과 동일한 주체(선생님/학생)만 가능.
  if (action === 'comment-create') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const admin = await requireAdminSessionOrApiToken(req);
    const author = await requireReviewAuthor(req, admin);
    if (!author) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { reviewId, text } = req.body || {};
    if (!reviewId) return res.status(400).json({ success: false, message: 'Missing reviewId' });
    try {
      const comment = await addComment(reviewId, { ...author, text });
      return res.status(200).json({ success: true, comment });
    } catch (e) {
      const status = e.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ success: false, message: e.message || '댓글 작성에 실패했습니다' });
    }
  }

  // 유료 강좌 결제 시작 — 결제창에 넘길 정보(결제ID/상점/채널/가격)를 서버가 발급한다.
  // 가격은 반드시 여기서 강좌 레코드를 다시 조회해 정하고, 클라이언트가 보낸 값은 쓰지 않는다.
  // 회원/학생 둘 다 결제 주체가 될 수 있다.
  if (action === 'create-payment') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { courseId } = req.body || {};
    if (!courseId) return res.status(400).json({ success: false, message: 'Missing courseId' });
    const payment = await createPendingPayment(courseId, owner.ownerType, owner.ownerId);
    if (!payment) return res.status(404).json({ success: false, message: '강좌를 찾을 수 없습니다' });
    return res.status(200).json({ success: true, payment });
  }

  // 결제창에서 결제가 끝난 직후 클라이언트가 호출 — 서버가 포트원에 직접 재조회해 검증하고,
  // 통과하면 수강권을 자동 부여한다(관리자 승인 단계 없음). 웹훅에서도 같은 함수를 호출하므로 멱등하게 동작한다.
  if (action === 'complete-payment') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { paymentId } = req.body || {};
    if (!paymentId) return res.status(400).json({ success: false, message: 'Missing paymentId' });
    const result = await verifyAndCompletePayment(paymentId, owner);
    if (!result.ok) return res.status(400).json({ success: false, message: result.message });
    return res.status(200).json({ success: true, courseTitle: result.courseTitle, expiresAt: result.expiresAt });
  }

  const admin = await requireAdminSessionOrApiToken(req);
  if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (action === 'admin-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const courses = await listAllCourses();
    return res.status(200).json({ success: true, courses });
  }

  // 승인 절차 없이 즉시 공개되는 게시판이므로, 스팸/부적절한 글은 관리자가 사후 삭제한다.
  if (action === 'review-delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
    await deleteReview(id);
    return res.status(200).json({ success: true });
  }

  if (action === 'comment-delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { reviewId, commentId } = req.body || {};
    if (!reviewId || !commentId) return res.status(400).json({ success: false, message: 'Missing reviewId/commentId' });
    await deleteComment(reviewId, commentId);
    return res.status(200).json({ success: true });
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
  // 회원(memberId)뿐 아니라 학생(schoolId+studentId)에게도 부여 가능 — 기존 memberId 전용
  // 호출부와의 호환을 위해 memberId만 오면 회원으로, schoolId+studentId가 오면 학생으로 처리.
  if (action === 'grant-entitlement') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { memberId, schoolId, studentId, courseId, days } = req.body || {};
    if ((!memberId && !(schoolId && studentId)) || !courseId) {
      return res.status(400).json({ success: false, message: 'Missing memberId 또는 schoolId+studentId, courseId' });
    }
    const ownerType = memberId ? 'member' : 'student';
    const ownerId = memberId ? memberId : makeStudentOwnerId(schoolId, studentId);
    const existing = await getOwnerEntitlements(ownerType, ownerId);
    if (existing === null) return res.status(404).json({ success: false, message: '대상을 찾을 수 없습니다' });
    const course = await getCourse(courseId);
    if (!course) return res.status(404).json({ success: false, message: '강좌를 찾을 수 없습니다' });
    const durationDays = Math.max(1, parseInt(days, 10) || course.durationDays || 30);
    const expiresAt = new Date(Date.now() + durationDays * 86400000).toISOString();
    const entitlements = existing.filter(e => e.courseId !== courseId);
    entitlements.push({
      courseId, purchasedAt: new Date().toISOString(), expiresAt,
      paymentId: 'manual', amount: 0, status: 'active', source: 'admin', grantedBy: admin.actorId || admin.actorName || 'admin',
    });
    const updated = await setOwnerEntitlements(ownerType, ownerId, entitlements);
    if (ownerType === 'member') await removeApplicant(courseId, memberId);
    return res.status(200).json({ success: true, owner: { ownerType, ownerId }, entitlements: updated?.entitlements || entitlements });
  }

  // 환불/취소 시 관리자가 수강권을 회수한다(설계 문서: 자동 환불은 범위 밖, 수동 처리).
  if (action === 'revoke-entitlement') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { memberId, schoolId, studentId, courseId } = req.body || {};
    if ((!memberId && !(schoolId && studentId)) || !courseId) {
      return res.status(400).json({ success: false, message: 'Missing memberId 또는 schoolId+studentId, courseId' });
    }
    const ownerType = memberId ? 'member' : 'student';
    const ownerId = memberId ? memberId : makeStudentOwnerId(schoolId, studentId);
    const existing = await getOwnerEntitlements(ownerType, ownerId);
    if (existing === null) return res.status(404).json({ success: false, message: '대상을 찾을 수 없습니다' });
    const entitlements = existing.map(e => e.courseId === courseId ? { ...e, status: 'revoked' } : e);
    const updated = await setOwnerEntitlements(ownerType, ownerId, entitlements);
    return res.status(200).json({ success: true, owner: { ownerType, ownerId }, entitlements: updated?.entitlements || entitlements });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
