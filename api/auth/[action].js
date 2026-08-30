import {
  verifyPassword, createSession, setSessionCookie,
  checkLoginRateLimit, checkRateLimit, isSameOrigin, getClientIp,
  getSessionToken, getSession, deleteSession, clearSessionCookie,
  getAdminAccounts, findAdminAccount, listPendingTaRequests, requireAdminSession,
} from '../_lib/auth.js';
import { findStudentByCredentials, findStudentByProfile } from '../_lib/school.js';

// Vercel 함수 개수 제한(Hobby 12개)에 맞추기 위해 login/session/logout을 한 파일로 통합.
// /api/auth/login, /api/auth/session, /api/auth/logout 경로는 그대로 유지됨(동적 라우트).
export default async function handler(req, res) {
  const { action } = req.query;

  if (action === 'login') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

    const { role, id, pw } = req.body || {};
    if (!role || !id || !pw) return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력하세요' });

    const rlOk = await checkLoginRateLimit(String(id).toLowerCase() + ':' + getClientIp(req));
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    if (role === 'admin') {
      const { accounts } = await getAdminAccounts();
      const account = findAdminAccount(accounts, id);
      if (!account || !verifyPassword(pw, account.pwdHash)) {
        if (!account) {
          const norm = String(id).trim().toLowerCase();
          const requests = await listPendingTaRequests();
          if (requests.some(p => p.id === norm)) {
            return res.status(401).json({ success: false, message: '아직 원장님 승인 대기 중인 계정입니다' });
          }
        }
        return res.status(401).json({ success: false, message: 'ID 또는 비밀번호 오류' });
      }
      const { token, maxAge } = await createSession({
        role: 'admin', actorId: account.id, actorName: account.name, isMaster: account.isMaster === true,
        passwordChangedAt: account.passwordChangedAt,
      });
      setSessionCookie(res, token, maxAge);
      return res.status(200).json({
        success: true, role: 'admin', actorName: account.name, isMaster: account.isMaster === true,
      });
    }

    if (role === 'student') {
      const found = await findStudentByCredentials(id, pw);
      if (!found) return res.status(401).json({ success: false, message: 'ID 또는 비밀번호를 확인해주세요' });
      const { token, maxAge } = await createSession({ role: 'student', schoolId: found.schoolId, studentId: found.studentId });
      setSessionCookie(res, token, maxAge);
      return res.status(200).json({ success: true, role: 'student' });
    }

    return res.status(400).json({ success: false, message: '알 수 없는 역할입니다' });
  }

  if (action === 'find-account') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

    const { name, phone, parentPhone } = req.body || {};
    if (!name || !phone || !parentPhone) {
      return res.status(400).json({ success: false, message: '이름·학생번호·학부모번호를 모두 입력하세요' });
    }

    // 로그인 전(세션 없음) 화면이라 이름+전화번호 두 개만으로 무차별 대입이 가능해지지 않도록
    // IP당 요청 수를 빡빡하게 제한 — checkLoginRateLimit(1분 10회)보다 더 낮춤.
    const rlOk = await checkRateLimit('find-account', getClientIp(req), 5, 60);
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const found = await findStudentByProfile(name, phone, parentPhone);
    if (!found) {
      return res.status(404).json({ success: false, message: '일치하는 계정을 찾을 수 없습니다' });
    }
    // 비밀번호 원문은 절대 내려주지 않고, 첫 글자 + 마스킹 + 자릿수 힌트만 서버에서 계산해 전달
    const pwd = found.pwd || '';
    const pwdHint = pwd.length > 0 ? pwd[0] + '●'.repeat(pwd.length - 1) + ` (${pwd.length}자리)` : '(정보 없음)';
    return res.status(200).json({
      success: true,
      schoolName: found.schoolName, schoolGrade: found.schoolGrade,
      studentId: found.studentId, pwdHint,
    });
  }

  if (action === 'session') {
    if (req.method !== 'GET') return res.status(405).end();
    const token = getSessionToken(req);
    let session = await getSession(token);
    if (!session) return res.status(401).json({ success: false, message: '세션이 없습니다' });
    // 관리자 세션은 requireAdminSession과 동일한 검증(계정 삭제/비밀번호 변경 여부)을 거치게
    // 해서, 여기서만 별도로 느슨한 검사를 하다가 로직이 갈라지는 일이 없게 함.
    if (session.role === 'admin') {
      session = await requireAdminSession(req);
      if (!session) return res.status(401).json({ success: false, message: '세션이 없습니다' });
    }
    return res.status(200).json({
      success: true, role: session.role,
      actorName: session.actorName || '', isMaster: session.isMaster === true,
    });
  }

  if (action === 'logout') {
    if (req.method !== 'POST') return res.status(405).end();
    const token = getSessionToken(req);
    await deleteSession(token);
    clearSessionCookie(res);
    return res.status(200).json({ success: true });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
