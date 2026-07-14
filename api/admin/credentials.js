import { requireAdminSession, isSameOrigin, verifyPassword, hashPassword } from '../_lib/auth.js';
import { getRedis } from '../_lib/redis.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const session = await requireAdminSession(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

  const { currentPw, newId, newPw } = req.body || {};
  if (!currentPw) return res.status(400).json({ success: false, message: '현재 비밀번호를 입력하세요' });

  const redis = getRedis();
  const admin = await redis.get('admin:auth');
  if (!admin || !verifyPassword(currentPw, admin.pwdHash)) {
    return res.status(400).json({ success: false, message: '현재 비밀번호가 틀렸습니다' });
  }

  const next = { ...admin };
  if (newId) {
    const id = String(newId).trim().toLowerCase();
    if (id.length < 4 || /\s/.test(id)) {
      return res.status(400).json({ success: false, message: '아이디는 공백 없이 4자 이상이어야 합니다' });
    }
    next.id = id;
  }
  if (newPw) {
    if (String(newPw).length < 4) {
      return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });
    }
    next.pwdHash = hashPassword(newPw);
  }

  await redis.set('admin:auth', next);
  return res.status(200).json({ success: true, id: next.id });
}
