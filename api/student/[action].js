import { requireStudentSession, isSameOrigin, verifyPassword, hashPassword, encryptPwd } from '../_lib/auth.js';
import { getSchool, mutateSchool, SchoolMutationError } from '../_lib/school.js';
import { notifyAdminNewSuggestion } from '../_lib/email.js';
import {
  listRounds, getRound, getSubmission, putSubmission, getAggregate,
  countSubmissions, countStudentsInGrade,
  normalizeGrade, parseScore, parseGradeLevel, isRoundOpen, studentViewOf,
} from '../_lib/mock.js';

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
        hw1: sc.hw1, hw2: sc.hw2, hw3: sc.hw3, hw4: sc.hw4,
        hw1Skip: sc.hw1Skip, hw2Skip: sc.hw2Skip, hw3Skip: sc.hw3Skip, hw4Skip: sc.hw4Skip, hwNames: sc.hwNames || {},
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
      const student = (result.school.students || []).find(s => s.id === session.studentId);
      await notifyAdminNewSuggestion(result.school.name, student?.name || session.studentId, suggestion.cat, suggestion.txt);
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

  if (action === 'mock') {
    if (req.method !== 'GET') return res.status(405).end();
    const sc = await getSchool(session.schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    const myGrade = normalizeGrade(sc.grade);
    const rounds = await listRounds();
    const now = Date.now();

    // 입력칸을 띄울 회차 — 지금 내 학년 기준. 열린 회차가 둘 이상이면(예: 3월 회차 마감 전에
    // 4월 회차를 미리 열어둔 경우) 마감이 가장 임박한 것을 보여준다. 놓치면 안 되는 쪽이 먼저다.
    const open = rounds
      .filter(r => !r.archived && normalizeGrade(r.grade) === myGrade && isRoundOpen(r, now))
      .sort((a, b) => a.closeAt - b.closeAt)[0];
    let openRound = null;
    if (open) {
      const [mySub, submittedCount, totalCount] = await Promise.all([
        getSubmission(open.id, session.studentId),
        countSubmissions(open.id),
        countStudentsInGrade(myGrade),
      ]);
      openRound = {
        id: open.id, title: open.title, examDate: open.examDate,
        closeAt: open.closeAt, maxScore: open.maxScore,
        mySubmission: mySub ? { score: mySub.score, grade: mySub.grade ?? null, updatedAt: mySub.updatedAt } : null,
        submittedCount, totalCount,
      };
    }

    // 지난 기록 — 학년으로 거르지 않는다. 진급은 반의 학년만 바꾸는 방식이라
    // 학년으로 거르면 2학년이 되는 순간 1학년 기록이 화면에서 사라진다
    // (데이터는 남아 있는데 안 보이는, 알아채기 어려운 형태의 손실).
    const closedRounds = rounds.filter(r => now >= r.closeAt);
    const pairs = await Promise.all(closedRounds.map(async (r) => {
      const sub = await getSubmission(r.id, session.studentId);
      if (!sub) return null;
      const agg = await getAggregate(r.id);
      return studentViewOf(r, sub, agg, now);
    }));
    const history = pairs.filter(Boolean)
      .sort((a, b) => String(a.examDate || '').localeCompare(String(b.examDate || '')));

    return res.status(200).json({ success: true, openRound, history });
  }

  if (action === 'mock-submit') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { roundId, score, grade } = req.body || {};
    const round = await getRound(roundId);
    if (!round) return res.status(404).json({ success: false, message: '회차를 찾을 수 없습니다' });
    if (!isRoundOpen(round)) return res.status(403).json({ success: false, message: '입력이 마감되었습니다' });

    const sc = await getSchool(session.schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    if (normalizeGrade(sc.grade) !== normalizeGrade(round.grade)) {
      return res.status(403).json({ success: false, message: '학년이 맞지 않는 회차입니다' });
    }
    const student = (sc.students || []).find(s => s.id === session.studentId);
    if (!student) return res.status(404).json({ success: false, message: '학생 정보를 찾을 수 없습니다' });

    const s = parseScore(score, round.maxScore);
    if (s === null) return res.status(400).json({ success: false, message: `점수는 0~${round.maxScore} 사이 정수로 입력하세요` });
    const g = parseGradeLevel(grade);
    if (!g.ok) return res.status(400).json({ success: false, message: '등급은 1~9 중에서 선택하세요' });

    const prev = await getSubmission(roundId, session.studentId);
    const now = Date.now();
    const sub = {
      sid: session.studentId,
      schoolId: sc.id, schoolName: sc.name, name: student.name,
      score: s, grade: g.value,
      submittedAt: prev?.submittedAt || now,
      updatedAt: now,
      editedBy: null,
      // 선생님이 집계에서 제외해둔 학생이 다시 제출한다고 제외가 풀리면 안 된다
      excluded: prev?.excluded || false,
      memo: prev?.memo || '',
    };
    await putSubmission(roundId, sub);
    return res.status(200).json({ success: true, submission: { score: sub.score, grade: sub.grade, updatedAt: sub.updatedAt } });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
