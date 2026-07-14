import { getRedis } from './_lib/redis.js';
import { checkRateLimit, getClientIp, requireStudentSession } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let { studentId, schoolId } = req.body || {};
  const { subscription } = req.body || {};
  if (!subscription) return res.status(400).json({ error: 'Missing fields' });

  if (studentId === 'admin') {
    if (!process.env.API_AUTH_TOKEN || req.headers['x-api-token'] !== process.env.API_AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else {
    // 학생 세션이 있으면 세션의 신원을 우선 사용해 본문 값을 덮어씀 — 다른 학생 사칭 방지.
    // 세션이 없는 경우(구버전 캐시된 클라이언트 등)엔 본문 값을 그대로 신뢰하는 완화책 유지.
    const session = await requireStudentSession(req);
    if (session) {
      studentId = session.studentId;
      schoolId = session.schoolId;
    }
  }

  if (!studentId || !schoolId) return res.status(400).json({ error: 'Missing fields' });

  const ip = getClientIp(req);
  const ok = await checkRateLimit('subscribe', ip, 20, 60);
  if (!ok) return res.status(429).json({ error: 'Too many requests' });

  const redis = getRedis();
  // 1년 TTL로 구독 정보 저장
  await redis.set(
    `sub:${schoolId}:${studentId}`,
    subscription,
    { ex: 60 * 60 * 24 * 365 }
  );

  return res.status(200).json({ ok: true });
}
