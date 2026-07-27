import {
  requireAdminSessionOrApiToken, requireMasterAdminSessionOrApiToken,
  isSameOrigin, verifyPassword, hashPassword, encryptPwd,
  getAdminAccounts, setAdminAccounts, findAdminAccount,
  listPendingTaRequests, addPendingTaRequest, removePendingTaRequest, claimPendingTaRequest,
  listTaNotices, addTaNotice, removeTaNotice,
  checkRateLimit, getClientIp,
  createSession, setSessionCookie, getSessionToken, deleteSession,
} from '../_lib/auth.js';
import { getRedis } from '../_lib/redis.js';
import {
  getSchoolIndex, getSchool, createSchool, putSchoolRaw,
} from '../_lib/school.js';
import { getMessageHistory } from '../_lib/sms.js';

const MAX_BODY_CHARS = 5_000_000; // 5MB — 마이그레이션 업로드용 상한

function maxStudentIdSuffix(schools) {
  let max = 0;
  schools.forEach(sc => {
    // 탈퇴 학생도 포함해야 한다 — 탈퇴 학생 ID가 최댓값인 상태에서 새 학생에게 같은 ID를
    // 내주면, 나중에 그 탈퇴 학생을 복구할 때 ID가 겹친다(Codex 리뷰에서 지적됨).
    [...(sc.students || []), ...(sc.withdrawnStudents || [])].forEach(s => {
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
      const taNotices = await listTaNotices(0); // 0 → 개수 제한 없이 전체 백업
      const taPending = await listPendingTaRequests();
      const exportedAt = new Date().toISOString();
      const payload = { exportedAt, schoolIndex: index, schools, admin: admin || null, taNotices, taPending };
      await githubPutFile(repo, 'oheng-backup.json', JSON.stringify(payload, null, 2), `백업 ${exportedAt}`, token);
      return res.status(200).json({ success: true, schoolsBackedUp: schools.length, exportedAt });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  // 조교 계정 신청: 로그인 전 상태에서 접근하는 공개 엔드포인트라 세션 체크보다 먼저 처리.
  // 즉시 admin:auth에 계정을 만들지 않고 ta:pending에 대기 등록만 하며, 원장님 승인(ta-approve) 후에만
  // 실제 로그인 가능한 계정이 된다.
  if (action === 'ta-signup') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });

    const rlOk = await checkRateLimit('ta-signup', getClientIp(req), 5, 60);
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const { id: rawId, name, pw } = req.body || {};
    const id = String(rawId || '').trim().toLowerCase();
    if (id.length < 4 || /\s/.test(id)) return res.status(400).json({ success: false, message: '아이디는 공백 없이 4자 이상이어야 합니다' });
    if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: '이름을 입력하세요' });
    if (!pw || String(pw).length < 4) return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });

    const { accounts } = await getAdminAccounts();
    if (accounts.some(a => a.id === id)) return res.status(400).json({ success: false, message: '이미 사용 중인 아이디입니다' });

    // HSETNX는 Redis 서버에서 원자적으로 처리되므로, 동시에 같은 아이디로 신청이 두 번
    // 들어와도 하나만 통과한다 (get-then-set 방식과 달리 경쟁 상태가 생기지 않음).
    const added = await addPendingTaRequest({ id, name: String(name).trim(), pwdHash: hashPassword(pw), requestedAt: new Date().toISOString() });
    if (!added) return res.status(400).json({ success: false, message: '이미 신청된 아이디입니다. 원장님 승인을 기다려주세요' });
    return res.status(200).json({ success: true });
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

  // 문자 발송 API 호출이 200(접수 성공)이어도 실제 통신사 배달까지 성공했다는 보장은 아니라서,
  // 배달 상태/실패 사유를 나중에 조회할 수 있게 하는 디버깅용 엔드포인트.
  if (action === 'sms-status') {
    if (req.method !== 'GET') return res.status(405).end();
    const phone = String(req.query.phone || '').replace(/[^0-9]/g, '');
    if (phone.length < 10) return res.status(400).json({ success: false, message: '휴대폰 번호를 확인해주세요' });
    try {
      const result = await getMessageHistory(phone, 10);
      const messages = (result?.messageList ? Object.values(result.messageList) : []).map(m => ({
        to: m.to, status: m.status, statusCode: m.statusCode, reason: m.reason,
        networkName: m.networkName, dateCreated: m.dateCreated, dateReported: m.dateReported,
      }));
      return res.status(200).json({ success: true, messages });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  if (action === 'next-student-id') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 500);
    const redis = getRedis();
    // cnt:studentId가 실제 학생 ID 최댓값보다 뒤처져 있으면(과거 클라이언트 로컬 채번으로 우회 등록된
    // 학생이 있는 경우) 그 값 그대로 증가시켜봐야 이미 쓰이고 있는 ID와 다시 충돌한다 — 매번 실제
    // 전체 학교 데이터에서 최댓값을 확인해 카운터가 뒤처져 있으면 먼저 따라잡힌 뒤에 증가시킨다.
    const index = await getSchoolIndex();
    const schools = (await Promise.all(index.map(id => getSchool(id)))).filter(Boolean);
    const realMax = maxStudentIdSuffix(schools);
    // 따라잡기(SET)와 증가(INCR)를 따로 하면 두 요청이 동시에 들어올 때 하나가 SET으로
    // 카운터를 되돌려서 같은 ID가 두 번 발급될 수 있다(Codex 리뷰에서 지적됨, P1) — Lua
    // 스크립트로 묶어 Redis 서버에서 원자적으로 처리한다.
    const CATCHUP_AND_INCR = `
      local key = KEYS[1]
      local realMax = tonumber(ARGV[1])
      local count = tonumber(ARGV[2])
      local current = tonumber(redis.call('GET', key) or '0')
      if realMax > current then
        redis.call('SET', key, realMax)
      end
      return redis.call('INCRBY', key, count)
    `;
    const final = await redis.eval(CATCHUP_AND_INCR, ['cnt:studentId'], [realMax, count]);
    const ids = [];
    for (let n = final - count + 1; n <= final; n++) {
      ids.push('s' + String(n).padStart(3, '0'));
    }
    return res.status(200).json({ success: true, ids, id: ids[0] });
  }

  if (action === 'credentials') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { currentPw, newId, newName, newPw } = req.body || {};
    if (!currentPw) return res.status(400).json({ success: false, message: '현재 비밀번호를 입력하세요' });

    const { version, accounts } = await getAdminAccounts();
    // 쿠키 세션이면 본인 계정(actorId), API 토큰 경로면 유일한 마스터 계정을 "본인"으로 취급
    // (이 시스템에서 마스터 계정은 항상 정확히 1개 — ta-create는 조교만 만들 수 있음)
    const targetId = session.actorId || accounts.find(a => a.isMaster === true)?.id;
    const target = findAdminAccount(accounts, targetId);
    if (!target || !verifyPassword(currentPw, target.pwdHash)) {
      return res.status(400).json({ success: false, message: '현재 비밀번호가 틀렸습니다' });
    }

    const isMaster = target.isMaster === true;
    if (!isMaster && (newId || newName)) {
      return res.status(400).json({ success: false, message: '아이디/이름 변경은 원장님 계정만 가능합니다' });
    }
    if (newId) {
      const id = String(newId).trim().toLowerCase();
      if (id.length < 4 || /\s/.test(id)) return res.status(400).json({ success: false, message: '아이디는 공백 없이 4자 이상이어야 합니다' });
      if (accounts.some(a => a.id === id && a.id !== target.id)) {
        return res.status(400).json({ success: false, message: '이미 사용 중인 아이디입니다' });
      }
      target.id = id;
    }
    if (newName) target.name = String(newName).trim();
    if (newPw) {
      if (String(newPw).length < 4) return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });
      target.pwdHash = hashPassword(newPw);
      target.passwordChangedAt = new Date().toISOString();
    }
    target.updatedAt = new Date().toISOString();
    try {
      await setAdminAccounts(accounts, version);
    } catch (e) {
      return res.status(409).json({ success: false, message: '다른 변경과 충돌했습니다. 다시 시도해주세요' });
    }

    // 쿠키 세션으로 로그인한 경우, 세션 레코드가 여전히 옛 actorId/actorName/isMaster를 들고 있어
    // (특히 아이디를 바꿨을 때) 이후 ta-list 등 마스터 전용 액션이 전부 막히고 credentials 재호출도
    // "비밀번호 틀림"으로 잘못 안내되는 문제가 생김 — 갱신된 계정 정보로 세션을 즉시 재발급해 방지
    // (API 토큰 경로는 session.actorId가 없어 이 블록을 자연스럽게 건너뜀)
    if (session.actorId) {
      const oldToken = getSessionToken(req);
      if (oldToken) await deleteSession(oldToken);
      const { token, maxAge } = await createSession({
        role: 'admin', actorId: target.id, actorName: target.name, isMaster: target.isMaster === true,
        passwordChangedAt: target.passwordChangedAt,
      });
      setSessionCookie(res, token, maxAge);
    }

    return res.status(200).json({ success: true, id: target.id });
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

    if (newPwd && !/^\d+$/.test(String(newPwd).trim())) {
      return res.status(400).json({ success: false, message: '비밀번호는 숫자만 입력할 수 있습니다' });
    }
    const pwd = (newPwd && String(newPwd).trim().length >= 4) ? String(newPwd).trim() : String(Math.floor(1000 + Math.random() * 9000));
    sc.students[idx].pwd = encryptPwd(pwd);
    sc.students[idx].pwdHash = hashPassword(pwd);
    sc.version = (sc.version || 0) + 1;
    await getRedis().set('school:' + schoolId, sc);
    return res.status(200).json({ success: true, password: pwd, studentId });
  }

  if (action === 'ta-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 볼 수 있습니다' });
    const { accounts } = await getAdminAccounts();
    return res.status(200).json({
      success: true,
      accounts: accounts.map(a => ({
        id: a.id, name: a.name, isMaster: a.isMaster === true,
        createdAt: a.createdAt, updatedAt: a.updatedAt, passwordChangedAt: a.passwordChangedAt,
      })),
    });
  }

  if (action === 'ta-create') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 가능합니다' });

    const rlOk = await checkRateLimit('ta-create', getClientIp(req), 10, 60);
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const { id: rawId, name, pw } = req.body || {};
    const id = String(rawId || '').trim().toLowerCase();
    if (id.length < 4 || /\s/.test(id)) return res.status(400).json({ success: false, message: '아이디는 공백 없이 4자 이상이어야 합니다' });
    if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: '이름을 입력하세요' });
    if (!pw || String(pw).length < 4) return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });

    const { version, accounts } = await getAdminAccounts();
    if (accounts.some(a => a.id === id)) return res.status(400).json({ success: false, message: '이미 사용 중인 아이디입니다' });

    const now = new Date().toISOString();
    accounts.push({
      id, name: String(name).trim(), pwdHash: hashPassword(pw), isMaster: false,
      createdAt: now, updatedAt: now, passwordChangedAt: now,
    });
    try {
      await setAdminAccounts(accounts, version);
    } catch (e) {
      return res.status(409).json({ success: false, message: '다른 변경과 충돌했습니다. 다시 시도해주세요' });
    }
    return res.status(200).json({ success: true, id, name: String(name).trim() });
  }

  if (action === 'ta-reset-password') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 가능합니다' });

    const rlOk = await checkRateLimit('ta-reset-password', getClientIp(req), 5, 60);
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const { id: rawId, newPw } = req.body || {};
    const id = String(rawId || '').trim().toLowerCase();
    const { version, accounts } = await getAdminAccounts();
    const target = findAdminAccount(accounts, id);
    if (!target) return res.status(404).json({ success: false, message: '계정을 찾을 수 없습니다' });

    const pwd = (newPw && String(newPw).trim().length >= 4) ? String(newPw).trim() : String(Math.floor(1000 + Math.random() * 9000));
    target.pwdHash = hashPassword(pwd);
    target.passwordChangedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    try {
      await setAdminAccounts(accounts, version);
    } catch (e) {
      return res.status(409).json({ success: false, message: '다른 변경과 충돌했습니다. 다시 시도해주세요' });
    }
    return res.status(200).json({ success: true, id: target.id, password: pwd });
  }

  if (action === 'ta-delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 가능합니다' });

    const rlOk = await checkRateLimit('ta-delete', getClientIp(req), 5, 60);
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const { id: rawId } = req.body || {};
    const id = String(rawId || '').trim().toLowerCase();
    const { version, accounts } = await getAdminAccounts();
    const target = findAdminAccount(accounts, id);
    if (!target) return res.status(404).json({ success: false, message: '계정을 찾을 수 없습니다' });

    const remainingMasters = accounts.filter(a => a.isMaster === true && a.id !== id).length;
    if (target.isMaster === true && remainingMasters < 1) {
      return res.status(400).json({ success: false, message: '마지막 원장님 계정은 삭제할 수 없습니다' });
    }

    const next = accounts.filter(a => a.id !== id);
    try {
      await setAdminAccounts(next, version);
    } catch (e) {
      return res.status(409).json({ success: false, message: '다른 변경과 충돌했습니다. 다시 시도해주세요' });
    }
    return res.status(200).json({ success: true, id });
  }

  if (action === 'ta-pending-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 볼 수 있습니다' });
    const requests = await listPendingTaRequests();
    return res.status(200).json({
      success: true,
      pending: requests.map(p => ({ id: p.id, name: p.name, requestedAt: p.requestedAt })),
    });
  }

  if (action === 'ta-approve') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 가능합니다' });

    const { id: rawId } = req.body || {};
    const id = String(rawId || '').trim().toLowerCase();

    // 읽고 나서 따로 지우면 그 사이에 다른 관리자의 거절이 끼어들어도 승인 쪽이 알아챌 수
    // 없다 — claim은 "내가 실제로 제거했을 때만" 데이터를 돌려주므로, 동시에 거절이 먼저
    // 일어났다면 여기서 null을 받아 승인을 진행하지 않는다.
    const target = await claimPendingTaRequest(id);
    if (!target) return res.status(404).json({ success: false, message: '신청 내역을 찾을 수 없습니다 (이미 처리되었을 수 있습니다)' });

    const now = new Date().toISOString();
    const newAccount = {
      id: target.id, name: target.name, pwdHash: target.pwdHash, isMaster: false,
      createdAt: now, updatedAt: now, passwordChangedAt: now,
    };

    // setAdminAccounts는 이제 Lua 스크립트로 버전 확인+쓰기를 원자적으로 처리하므로, 두
    // 승인이 동시에 들어와도 버전 충돌이 정확히 감지된다 — 충돌 시 최신 계정 목록을 다시
    // 읽어 재시도하면 두 승인 모두 반영된다.
    let approved = false;
    for (let attempt = 0; attempt < 3 && !approved; attempt++) {
      const latest = await getAdminAccounts();
      if (latest.accounts.some(a => a.id === id)) {
        return res.status(400).json({ success: false, message: '이미 사용 중인 아이디입니다. 신청이 취소되었습니다' });
      }
      try {
        await setAdminAccounts([...latest.accounts, newAccount], latest.version);
        approved = true;
      } catch (e) {
        if (e.code !== 'VERSION_CONFLICT') throw e;
      }
    }
    if (!approved) {
      // 계정 생성이 끝내 실패했으니 이미 claim으로 지워진 신청을 되살려서 재시도할 수 있게 함
      await addPendingTaRequest(target);
      return res.status(409).json({ success: false, message: '다른 변경과 충돌했습니다. 다시 시도해주세요' });
    }
    return res.status(200).json({ success: true, id: target.id, name: target.name });
  }

  if (action === 'ta-reject') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 가능합니다' });

    const { id: rawId } = req.body || {};
    const id = String(rawId || '').trim().toLowerCase();
    await removePendingTaRequest(id);
    return res.status(200).json({ success: true, id });
  }

  // 조교 공지사항: 학교 데이터와 무관한 전역 게시판. 작성은 원장님만, 열람은 모든 관리자 계정 가능.
  if (action === 'ta-notice-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const notices = await listTaNotices(50);
    return res.status(200).json({ success: true, notices });
  }

  if (action === 'ta-notice-post') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 작성할 수 있습니다' });

    const rlOk = await checkRateLimit('ta-notice-post', getClientIp(req), 10, 60);
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ success: false, message: '내용을 입력하세요' });
    if (text.length > 500) return res.status(400).json({ success: false, message: '500자 이내로 입력해주세요' });

    // id에 랜덤 접미사를 더해, 같은 밀리초에 두 글이 동시에 등록돼도 같은 해시 필드를 두고
    // 서로 덮어쓰는 일이 없게 함
    const id = 'tn' + Date.now() + Math.random().toString(36).slice(2, 8);
    const entry = { id, text, authorName: session.actorName || masterCheck.actorName || '원장님', createdAt: new Date().toISOString() };
    await addTaNotice(entry);
    return res.status(200).json({ success: true, notice: entry });
  }

  if (action === 'ta-notice-delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 가능합니다' });

    const { id } = req.body || {};
    await removeTaNotice(id);
    return res.status(200).json({ success: true });
  }

  if (action === 'append-save-log') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { schoolId, entry } = req.body || {};
    if (!schoolId || !entry) return res.status(400).json({ success: false, message: 'Missing schoolId/entry' });

    const sc = await getSchool(schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    // "누가"는 클라이언트 값을 신뢰하지 않고 서버가 세션에서 읽은 이름으로 덮어씀
    // (viaApiToken 경로는 session.actorName이 없으므로 클라이언트가 보낸 값이 그대로 쓰임 — 운영 호출용)
    const stampedEntry = { ...entry, actorName: session.actorName || entry.actorName || '' };
    sc.saveLogs = Array.isArray(sc.saveLogs) ? sc.saveLogs : [];
    sc.saveLogs.push(stampedEntry);
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

    const nowIso = new Date().toISOString();
    await redis.set('admin:auth', {
      version: 1,
      accounts: [{
        id: (adminId || 'admin').toLowerCase(), name: '원장님', pwdHash: hashPassword(adminPwd || 'oheng2024'),
        isMaster: true, createdAt: nowIso, updatedAt: nowIso, passwordChangedAt: nowIso,
      }],
    });
    for (const sc of schools) {
      await putSchoolRaw(sc);
    }
    await redis.set('school:index', schools.map(sc => sc.id));
    await redis.set('cnt:studentId', maxStudentIdSuffix(schools));

    return res.status(200).json({ success: true, dryRun: false, schoolsImported: schools.length, studentsHashed: studentCount });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
