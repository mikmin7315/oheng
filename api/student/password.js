import { requireStudentSession, isSameOrigin, verifyPassword, hashPassword } from '../_lib/auth.js';
import { getSchool } from '../_lib/school.js';
import { getRedis } from '../_lib/redis.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const session = await requireStudentSession(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

  const { currentPw, newPw } = req.body || {};
  if (!currentPw || !newPw) return res.status(400).json({ success: false, message: '현재/새 비밀번호를 입력하세요' });
  if (String(newPw).length < 4) return res.status(400).json({ success: false, message: '4자 이상 입력하세요' });

  const sc = await getSchool(session.schoolId);
  if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
  const idx = (sc.students || []).findIndex(s => s.id === session.studentId);
  if (idx < 0) return res.status(404).json({ success: false, message: '학생 정보를 찾을 수 없습니다' });
  if (!verifyPassword(currentPw, sc.students[idx].pwdHash)) {
    return res.status(400).json({ success: false, message: '현재 비밀번호가 틀렸습니다' });
  }

  sc.students[idx].pwdHash = hashPassword(newPw);
  sc.version = (sc.version || 0) + 1;
  await getRedis().set('school:' + session.schoolId, sc);

  return res.status(200).json({ success: true });
}
