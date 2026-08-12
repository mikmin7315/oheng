import { requireStudentSession, isSameOrigin, verifyPassword, hashPassword, encryptPwd } from '../_lib/auth.js';
import { getSchool, mutateSchool, SchoolMutationError } from '../_lib/school.js';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// Vercel 함수 개수 제한(Hobby 12개)에 맞추기 위해 me/password/suggestions/suggestion-read를 한 파일로 통합.
// /api/student/me 등 경로는 그대로 유지됨(동적 라우트).
export default async function handler(req, res) {
  const { action } = req.query;
  const session = await requireStudentSession(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (action === 'me') {
    if (req.method !== 'GET') return res.status(405).end();
    const sc = await getSchool(session.schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    const student = (sc.students || []).find(s => s.id === session.studentId);
    if (!student) return res.status(404).json({ success: false, message: '학생 정보를 찾을 수 없습니다' });

    return res.status(200).json({
      success: true,
      student: { id: student.id, name: student.name, phone: student.phone || '', parentPhone: student.parentPhone || '', type: student.type || 'regular' },
      school: {
        id: sc.id, name: sc.name, grade: sc.grade,
        hw1: sc.hw1, hw2: sc.hw2, hw2Skip: sc.hw2Skip, hwNames: sc.hwNames || {},
        notices: sc.notices || {}, kakaoChannel: sc.kakaoChannel || '',
      },
      records: (sc.records || []).filter(r => r.sid === session.studentId),
      aggregates: sc._aggregates || {},
      suggestions: (sc.suggestions || []).filter(s => s.sid === session.studentId),
    });
  }

  if (action === 'password') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { currentPw, newPw } = req.body || {};
    if (!currentPw || !newPw) return res.status(400).json({ success: false, message: '현재/새 비밀번호를 입력하세요' });
    if (String(newPw).length < 4) return res.status(400).json({ success: false, message: '4자 이상 입력하세요' });

    try {
      const result = await mutateSchool(session.schoolId, (sc) => {
        const idx = (sc.students || []).findIndex(s => s.id === session.studentId);
        if (idx < 0) throw new SchoolMutationError(404, '학생 정보를 찾을 수 없습니다');
        // 재시도마다 다시 읽은 최신 pwdHash로 검증 — 그 사이 비밀번호가 바뀌었어도 정확히 판정됨
        if (!verifyPassword(currentPw, sc.students[idx].pwdHash)) {
          throw new SchoolMutationError(400, '현재 비밀번호가 틀렸습니다');
        }
        sc.students[idx].pwd = encryptPwd(newPw);
        sc.students[idx].pwdHash = hashPassword(newPw);
      });
      if (!result) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
      return res.status(200).json({ success: true });
    } catch (e) {
      if (e instanceof SchoolMutationError) return res.status(e.status).json({ success: false, message: e.message });
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  if (action === 'suggestions') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { cat, txt } = req.body || {};
    const text = String(txt || '').trim();
    if (!text) return res.status(400).json({ success: false, message: '내용을 입력하세요' });

    const suggestion = { id: 'sug' + Date.now(), sid: session.studentId, cat: cat || '기타', txt: text, date: todayStr(), read: false };
    try {
      const result = await mutateSchool(session.schoolId, (sc) => {
        sc.suggestions = Array.isArray(sc.suggestions) ? sc.suggestions : [];
        sc.suggestions.push(suggestion);
      });
      if (!result) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
      return res.status(200).json({ success: true, suggestion });
    } catch (e) {
      if (e instanceof SchoolMutationError) return res.status(e.status).json({ success: false, message: e.message });
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  if (action === 'suggestion-read') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });

    try {
      const result = await mutateSchool(session.schoolId, (sc) => {
        const sug = (sc.suggestions || []).find(s => s.id === id && s.sid === session.studentId);
        if (!sug) throw new SchoolMutationError(404, '제안을 찾을 수 없습니다');
        sug.replyRead = true;
      });
      if (!result) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
      return res.status(200).json({ success: true });
    } catch (e) {
      if (e instanceof SchoolMutationError) return res.status(e.status).json({ success: false, message: e.message });
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
