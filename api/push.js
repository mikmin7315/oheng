import webpush from 'web-push';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:admin@oheng.vercel.app'
} = process.env;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'VAPID keys not configured' });
  }

  const { studentId, schoolId, title, body } = req.body;
  let { url = '/' } = req.body;
  if (!studentId || !schoolId) {
    return res.status(400).json({ error: 'Missing studentId or schoolId' });
  }
  // 알림 클릭 시 열리는 주소를 앱 내부 경로로 제한 (피싱 리다이렉트 방지)
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) {
    url = '/';
  }

  const subscription = await redis.get(`sub:${schoolId}:${studentId}`);
  if (!subscription) {
    return res.status(404).json({ error: 'No subscription for this user' });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  await webpush.sendNotification(
    subscription,
    JSON.stringify({ title: title || 'OHENG', body: body || '새 알림이 있습니다.', url, tag: 'oheng-reply' })
  );

  return res.status(200).json({ ok: true });
}
