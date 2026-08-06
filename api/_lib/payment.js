import { getRedis } from './redis.js';
import { PortOneClient } from '@portone/server-sdk';
import { getCourse, removeApplicant } from './course.js';
import { getMember, updateMemberEntitlements } from './member.js';

const PAYMENT_PREFIX = 'payment:';

function portone() {
  return PortOneClient({ secret: process.env.PORTONE_API_SECRET });
}

// 결제창을 열기 전, 서버가 강좌의 "진짜" 가격으로 결제 건을 미리 등록해둔다.
// 클라이언트가 보내는 금액은 절대 신뢰하지 않고, 검증 시 이 레코드의 courseId로 다시 조회한 가격과 대조한다.
export async function createPendingPayment(courseId, memberId) {
  const course = await getCourse(courseId);
  if (!course || !course.published) return null;
  const paymentId = 'pay' + Date.now() + Math.random().toString(36).slice(2, 8);
  const redis = getRedis();
  await redis.set(PAYMENT_PREFIX + paymentId, {
    paymentId, courseId, memberId, amount: course.price,
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
export async function verifyAndCompletePayment(paymentId) {
  const redis = getRedis();
  const record = await redis.get(PAYMENT_PREFIX + paymentId);
  if (!record) return { ok: false, message: '결제 정보를 찾을 수 없습니다' };
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

  const member = await getMember(record.memberId);
  if (!member) return { ok: false, message: '회원을 찾을 수 없습니다' };

  const expiresAt = new Date(Date.now() + course.durationDays * 86400000).toISOString();
  const entitlements = (member.entitlements || []).filter(e => e.courseId !== course.id);
  entitlements.push({
    courseId: course.id, purchasedAt: new Date().toISOString(), expiresAt,
    paymentId, amount: payment.amount.total, status: 'active',
  });
  await updateMemberEntitlements(record.memberId, entitlements);
  await removeApplicant(course.id, record.memberId).catch(() => {});

  await redis.set(PAYMENT_PREFIX + paymentId, {
    ...record, status: 'PAID', paidAt: new Date().toISOString(),
  });

  return { ok: true, courseId: course.id, courseTitle: course.title, expiresAt };
}

export async function getPaymentRecord(paymentId) {
  const redis = getRedis();
  return await redis.get(PAYMENT_PREFIX + paymentId);
}
