import { requireStudentSession } from '../_lib/auth.js';
import { getSchool } from '../_lib/school.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const session = await requireStudentSession(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const sc = await getSchool(session.schoolId);
  if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });

  const student = (sc.students || []).find(s => s.id === session.studentId);
  if (!student) return res.status(404).json({ success: false, message: '학생 정보를 찾을 수 없습니다' });

  // 반 친구 이름/전화번호/개별 성적은 절대 포함하지 않는다 — 본인 데이터 + 비민감 집계 수치만 반환
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
