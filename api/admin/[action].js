import { requireAdminSessionOrApiToken, isSameOrigin, verifyPassword, hashPassword, encryptPwd } from '../_lib/auth.js';
import { getRedis } from '../_lib/redis.js';
import {
  getSchoolIndex, getSchool, createSchool, putSchoolRaw,
} from '../_lib/school.js';

const MAX_BODY_CHARS = 5_000_000; // 5MB — 마이그레이션 업로드용 상한

function maxStudentIdSuffix(schools) {
  let max = 0;
  schools.forEach(sc => {
    (sc.students || []).forEach(s => {
      const m = /^s(\d+)$/.exec(s.id || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
  });
  return max;
}

function validateMigrateShape(body) {
  if (!body || typeof body !== 'object') return '요청 본문이 올바르지 않습니다';
  if (!Array.isArray(body.schools)) return 'schools 배열이 없습니다';
  for (const sc of body.schools) {
    if (!sc.id || !sc.name || !Array.isArray(sc.students) || !Array.isArray(sc.records)) {
      return `학교 데이터 형식 오류: ${sc?.id || '(id 없음)'}`;
    }
  }
  return null;
}

// GitHub Contents API로 파일을 생성/갱신 (비공개 백업 저장소 전용, 기존 sha가 있으면 갱신)
async function githubPutFile(repo, path, contentStr, message, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'oheng-backup' };
  let sha;
  const getRes = await fetch(url, { headers });
  if (getRes.ok) sha = (await getRes.json()).sha;
  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: Buffer.from(contentStr, 'utf8').toString('base64'), sha }),
  });
  if (!putRes.ok) {
    const errBody = await putRes.text().catch(() => '');
    throw new Error(`GitHub API 오류 (${putRes.status}): ${errBody.slice(0, 300)}`);
  }
  return putRes.json();
}

// Vercel 함수 개수 제한(Hobby 12개)에 맞추기 위해 schools/next-student-id/credentials/migrate/school-summary를
// 한 파일로 통합. /api/admin/schools 등 경로는 그대로 유지됨(동적 라우트).
export default async function handler(req, res) {
  const { action } = req.query;

  // backup-run: Vercel Cron이 매주 자동 호출 — 쿠키 세션 없이 CRON_SECRET로만 인증되므로
  // 아래 공통 관리자 세션 체크보다 먼저 처리 (수동 호출 시엔 기존 관리자 세션/API 토큰도 허용)
  if (action === 'backup-run') {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
    const isCron = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
    if (!isCron) {
      const manualSession = await requireAdminSessionOrApiToken(req);
      if (!manualSession) return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const token = process.env.GITHUB_BACKUP_TOKEN;
    const repo = process.env.GITHUB_BACKUP_REPO;
    if (!token || !repo) {
      return res.status(500).json({ success: false, message: 'GITHUB_BACKUP_TOKEN/GITHUB_BACKUP_REPO 환경변수가 설정되지 않았습니다' });
    }
    try {
      const redis = getRedis();
      const index = await getSchoolIndex();
      const schools = (await Promise.all(index.map(id => getSchool(id)))).filter(Boolean);
      const admin = await redis.get('admin:auth');
      const exportedAt = new Date().toISOString();
      const payload = { exportedAt, schoolIndex: index, schools, admin: admin || null };
      await githubPutFile(repo, 'oheng-backup.json', JSON.stringify(payload, null, 2), `백업 ${exportedAt}`, token);
      return res.status(200).json({ success: true, schoolsBackedUp: schools.length, exportedAt });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  const session = await requireAdminSessionOrApiToken(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (action === 'schools') {
    if (req.method === 'GET') {
      const index = await getSchoolIndex();
      const schools = await Promise.all(index.map(async id => {
        const sc = await getSchool(id);
        if (!sc) return null;
        return { id: sc.id, name: sc.name, grade: sc.grade, type: sc.type === 'lecture' ? 'lecture' : 'regular', studentCount: (sc.students || []).length, recordCount: (sc.records || []).length };
      }));
      return res.status(200).json({ success: true, schools: schools.filter(Boolean) });
    }
    if (req.method === 'POST') {
      if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
      const { name, grade, type } = req.body || {};
      if (!name) return res.status(400).json({ success: false, message: '학교 이름을 입력하세요' });
      const school = await createSchool(name, grade, type);
      return res.status(200).json({ success: true, school: { id: school.id, name: school.name, grade: school.grade, type: school.type, studentCount: 0, recordCount: 0 } });
    }
    return res.status(405).end();
  }

  if (action === 'next-student-id') {
    if (req.method !== 'POST') return res.status(405).end();
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

  if (action === 'credentials') {
    if (req.method !== 'POST') return res.status(405).end();
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
      if (id.length < 4 || /\s/.test(id)) return res.status(400).json({ success: false, message: '아이디는 공백 없이 4자 이상이어야 합니다' });
      next.id = id;
    }
    if (newPw) {
      if (String(newPw).length < 4) return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });
      next.pwdHash = hashPassword(newPw);
    }
    await redis.set('admin:auth', next);
    return res.status(200).json({ success: true, id: next.id });
  }

  if (action === 'reset-student-password') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { schoolId, studentId, newPwd } = req.body || {};
    if (!schoolId || !studentId) return res.status(400).json({ success: false, message: 'Missing schoolId/studentId' });

    const sc = await getSchool(schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    const idx = (sc.students || []).findIndex(s => s.id === studentId);
    if (idx < 0) return res.status(404).json({ success: false, message: '학생을 찾을 수 없습니다' });

    const pwd = (newPwd && String(newPwd).trim().length >= 4) ? String(newPwd).trim() : String(Math.floor(1000 + Math.random() * 9000));
    sc.students[idx].pwd = encryptPwd(pwd);
    sc.students[idx].pwdHash = hashPassword(pwd);
    sc.version = (sc.version || 0) + 1;
    await getRedis().set('school:' + schoolId, sc);
    return res.status(200).json({ success: true, password: pwd, studentId });
  }

  if (action === 'append-save-log') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { schoolId, entry } = req.body || {};
    if (!schoolId || !entry) return res.status(400).json({ success: false, message: 'Missing schoolId/entry' });

    const sc = await getSchool(schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    sc.saveLogs = Array.isArray(sc.saveLogs) ? sc.saveLogs : [];
    sc.saveLogs.push(entry);
    if (sc.saveLogs.length > 200) sc.saveLogs = sc.saveLogs.slice(-200);
    sc.version = (sc.version || 0) + 1;
    await getRedis().set('school:' + schoolId, sc);
    return res.status(200).json({ success: true });
  }

  if (action === 'append-send-log') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { schoolId, entry } = req.body || {};
    if (!schoolId || !entry) return res.status(400).json({ success: false, message: 'Missing schoolId/entry' });

    const sc = await getSchool(schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    sc.sendLogs = Array.isArray(sc.sendLogs) ? sc.sendLogs : [];
    sc.sendLogs.push(entry);
    if (sc.sendLogs.length > 1000) sc.sendLogs = sc.sendLogs.slice(-1000);
    sc.version = (sc.version || 0) + 1;
    await getRedis().set('school:' + schoolId, sc);
    return res.status(200).json({ success: true });
  }

  if (action === 'clear-send-logs') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { schoolId } = req.body || {};
    if (!schoolId) return res.status(400).json({ success: false, message: 'Missing schoolId' });

    const sc = await getSchool(schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    sc.sendLogs = [];
    sc.version = (sc.version || 0) + 1;
    await getRedis().set('school:' + schoolId, sc);
    return res.status(200).json({ success: true });
  }

  if (action === 'school-summary') {
    if (req.method !== 'GET') return res.status(405).end();
    const index = await getSchoolIndex();
    const summaries = await Promise.all(index.map(async id => {
      const sc = await getSchool(id);
      if (!sc) return { id, missing: true };
      return {
        id: sc.id, name: sc.name, grade: sc.grade,
        studentCount: (sc.students || []).length, recordCount: (sc.records || []).length,
        version: sc.version,
        hasHashedPasswords: (sc.students || []).every(s => typeof s.pwdHash === 'string' && s.pwdHash.startsWith('scrypt:')),
      };
    }));
    return res.status(200).json({ success: true, schoolIndex: index, schools: summaries });
  }

  if (action === 'migrate') {
    if (req.method !== 'POST') return res.status(405).end();

    const raw = JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_CHARS) return res.status(413).json({ success: false, message: '업로드 데이터가 너무 큽니다' });

    const shapeError = validateMigrateShape(req.body);
    if (shapeError) return res.status(400).json({ success: false, message: shapeError });

    const { schools, adminId, adminPwd } = req.body;
    const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
    const studentCount = schools.reduce((sum, sc) => sum + (sc.students?.length || 0), 0);

    if (dryRun) {
      return res.status(200).json({ success: true, dryRun: true, schoolsFound: schools.length, studentsFound: studentCount, willSetAdminId: adminId || 'admin' });
    }

    const redis = getRedis();
    try {
      const existingIndex = await getSchoolIndex();
      if (existingIndex.length) {
        const existingSchools = await Promise.all(existingIndex.map(id => getSchool(id)));
        const existingAdmin = await redis.get('admin:auth');
        await redis.set(`backup:migrate:${Date.now()}`, { schools: existingSchools.filter(Boolean), admin: existingAdmin || null }, { ex: 60 * 60 * 24 * 90 });
      }
    } catch (e) {
      return res.status(500).json({ success: false, message: '기존 데이터 백업 중 오류: ' + e.message });
    }

    await redis.set('admin:auth', { id: (adminId || 'admin').toLowerCase(), pwdHash: hashPassword(adminPwd || 'oheng2024') });
    for (const sc of schools) {
      await putSchoolRaw(sc);
    }
    await redis.set('school:index', schools.map(sc => sc.id));
    await redis.set('cnt:studentId', maxStudentIdSuffix(schools));

    return res.status(200).json({ success: true, dryRun: false, schoolsImported: schools.length, studentsHashed: studentCount });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
