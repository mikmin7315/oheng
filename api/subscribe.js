import { getRedis } from './_lib/redis.js';
import { checkRateLimit, getClientIp } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { studentId, schoolId, subscription } = req.body;
  if (!studentId || !schoolId || !subscription) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (studentId === 'admin' && (!process.env.API_AUTH_TOKEN || req.headers['x-api-token'] !== process.env.API_AUTH_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 임시 완화책: 학생 경로는 아직 로그인 세션과 연동되지 않아 studentId를 그대로 신뢰함.
  // 남용 방지를 위해 IP당 호출 빈도만 제한 — 실제 신원 검증은 세션 도입(4~5단계) 이후 추가 예정.
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
