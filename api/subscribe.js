import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { studentId, schoolId, subscription } = req.body;
  if (!studentId || !schoolId || !subscription) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (studentId === 'admin' && (!process.env.API_AUTH_TOKEN || req.headers['x-api-token'] !== process.env.API_AUTH_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 1년 TTL로 구독 정보 저장
  await redis.set(
    `sub:${schoolId}:${studentId}`,
    subscription,
    { ex: 60 * 60 * 24 * 365 }
  );

  return res.status(200).json({ ok: true });
}
