import { requireAdminSession, isSameOrigin } from '../_lib/auth.js';
import { getRedis } from '../_lib/redis.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const session = await requireAdminSession(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 500);
  const redis = getRedis();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const n = await redis.incr('cnt:studentId');
    ids.push('s' + String(n).padStart(3, '0'));
  }

  return res.status(200).json({ success: true, ids, id: ids[0] });
}
