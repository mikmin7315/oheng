import { getRedis } from './redis.js';
import { PortOneClient } from '@portone/server-sdk';
import { getCourse, removeApplicant } from './course.js';
import { getOwnerEntitlements, setOwnerEntitlements } from './entitlements.js';

const PAYMENT_PREFIX = 'payment:';

function portone() {
  return PortOneClient({ secret: process.env.PORTONE_API_SECRET });
}

// 결제창을 열기 전, 서버가 강좌의 "진짜" 가격으로 결제 건을 미리 등록해둔다.
// 클라이언트가 보내는 금액은 절대 신뢰하지 않고, 검증 시 이 레코드의 courseId로 다시 조회한 가격과 대조한다.
// ownerType/ownerId — 회원(member) 또는 학생(student) 양쪽 다 결제 주체가 될 수 있다.
export async function createPendingPayment(courseId, ownerType, ownerId) {
  const course = await getCourse(courseId);
  if (!course || !course.published) return null;
  const paymentId = 'pay' + Date.now() + Math.random().toString(36).slice(2, 8);
  const redis = getRedis();
  await redis.set(PAYMENT_PREFIX + paymentId, {
    paymentId, courseId, ownerType, ownerId, amount: course.price,
    status: 'PENDING', createdAt: new Date().toISOString(),
  });
  return {
    paymentId,
    storeId: process.env.PORTONE_STORE_ID,
    channelKey: process.env.PORTONE_CHANNEL_KEY,
    orderName: course.title,
    totalAmount: course.price,
    currency: 'KRW',
  };
}

// 결제 완료 콜백(/api/courses/complete-payment)과 웹훅 양쪽에서 호출 — 두 번 호출돼도
// 안전하도록(멱등) status가 이미 PAID면 바로 성공 처리하고 종료한다.
// requesterOwner — HTTP 콜백 경로에서는 "이 결제, 정말 로그인한 본인 거 맞아?"를 확인하기 위해
// 넘긴다(Codex 리뷰에서 지적된 허점: 세션 확인 없이 paymentId만으로 아무나 완료 처리를 트리거할
// 수 있었음). 웹훅 경로는 세션이 없으므로 undefined로 호출 — 대신 서명 검증으로 신뢰한다.
export async function verifyAndCompletePayment(paymentId, requesterOwner) {
  const redis = getRedis();
  const record = await redis.get(PAYMENT_PREFIX + paymentId);
  if (!record) return { ok: false, message: '결제 정보를 찾을 수 없습니다' };
  if (requesterOwner && (record.ownerType !== requesterOwner.ownerType || record.ownerId !== requesterOwner.ownerId)) {
    return { ok: false, message: '본인 결제만 확인할 수 있습니다' };
  }
  if (record.status === 'PAID') return { ok: true, alreadyProcessed: true, courseId: record.courseId };

  let payment;
  try {
    payment = await portone().payment.getPayment({ paymentId });
  } catch (e) {
    return { ok: false, message: '결제 조회에 실패했습니다' };
  }
  if (payment.status !== 'PAID') return { ok: false, message: '결제가 완료되지 않았습니다' };

  const course = await getCourse(record.courseId);
  if (!course) return { ok: false, message: '강좌를 찾을 수 없습니다' };
  // 결제 금액이 강좌 실제 가격과 다르면(클라이언트 변조/가격 변경 등) 거부
  if (payment.amount.total !== record.amount || payment.amount.total !== course.price) {
    return { ok: false, message: '결제 금액이 일치하지 않습니다' };
  }

  const existing = await getOwnerEntitlements(record.ownerType, record.ownerId);
  if (existing === null) return { ok: false, message: '결제 대상을 찾을 수 없습니다' };

  const expiresAt = new Date(Date.now() + course.durationDays * 86400000).toISOString();
  const entitlements = existing.filter(e => e.courseId !== course.id);
  entitlements.push({
    courseId: course.id, purchasedAt: new Date().toISOString(), expiresAt,
    paymentId, amount: payment.amount.total, status: 'active', source: 'payment',
  });
  await setOwnerEntitlements(record.ownerType, record.ownerId, entitlements);
  // 신청자 대기열은 지금까지 회원(member) 전용 개념이라 학생 결제에는 해당 사항 없음
  if (record.ownerType === 'member') {
    await removeApplicant(course.id, record.ownerId).catch(() => {});
  }

  await redis.set(PAYMENT_PREFIX + paymentId, {
    ...record, status: 'PAID', paidAt: new Date().toISOString(),
  });

  return { ok: true, courseId: course.id, courseTitle: course.title, expiresAt };
}

export async function getPaymentRecord(paymentId) {
  const redis = getRedis();
  return await redis.get(PAYMENT_PREFIX + paymentId);
}
