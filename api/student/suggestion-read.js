import { requireStudentSession, isSameOrigin } from '../_lib/auth.js';
import { getSchool } from '../_lib/school.js';
import { getRedis } from '../_lib/redis.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const session = await requireStudentSession(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ success: false, message: 'Missing id' });

  const sc = await getSchool(session.schoolId);
  if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });

  // 본인이 받은 제안(sid 일치)만 읽음 처리 가능 — 남의 것은 조작 못 하게 방지
  const sug = (sc.suggestions || []).find(s => s.id === id && s.sid === session.studentId);
  if (!sug) return res.status(404).json({ success: false, message: '제안을 찾을 수 없습니다' });

  sug.replyRead = true;
  sc.version = (sc.version || 0) + 1;
  await getRedis().set('school:' + session.schoolId, sc);

  return res.status(200).json({ success: true });
}
