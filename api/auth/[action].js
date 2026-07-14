import { getRedis } from '../_lib/redis.js';
import {
  verifyPassword, createSession, setSessionCookie,
  checkLoginRateLimit, isSameOrigin, getClientIp,
  getSessionToken, getSession, deleteSession, clearSessionCookie,
} from '../_lib/auth.js';
import { findStudentByCredentials } from '../_lib/school.js';

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
      const redis = getRedis();
      const admin = await redis.get('admin:auth');
      if (!admin || admin.id !== String(id).trim().toLowerCase() || !verifyPassword(pw, admin.pwdHash)) {
        return res.status(401).json({ success: false, message: 'ID 또는 비밀번호 오류' });
      }
      const { token, maxAge } = await createSession({ role: 'admin' });
      setSessionCookie(res, token, maxAge);
      return res.status(200).json({ success: true, role: 'admin' });
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

  if (action === 'session') {
    if (req.method !== 'GET') return res.status(405).end();
    const token = getSessionToken(req);
    const session = await getSession(token);
    if (!session) return res.status(401).json({ success: false, message: '세션이 없습니다' });
    return res.status(200).json({ success: true, role: session.role });
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
