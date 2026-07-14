import { requireStudentSession, isSameOrigin } from '../_lib/auth.js';
import { getSchool } from '../_lib/school.js';
import { getRedis } from '../_lib/redis.js';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const session = await requireStudentSession(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

  const { cat, txt } = req.body || {};
  const text = String(txt || '').trim();
  if (!text) return res.status(400).json({ success: false, message: '내용을 입력하세요' });

  const sc = await getSchool(session.schoolId);
  if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });

  const suggestion = { id: 'sug' + Date.now(), sid: session.studentId, cat: cat || '기타', txt: text, date: todayStr(), read: false };
  sc.suggestions = Array.isArray(sc.suggestions) ? sc.suggestions : [];
  sc.suggestions.push(suggestion);
  sc.version = (sc.version || 0) + 1;
  await getRedis().set('school:' + session.schoolId, sc);

  return res.status(200).json({ success: true, suggestion });
}
