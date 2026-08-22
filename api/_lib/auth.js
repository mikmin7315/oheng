import crypto from 'crypto';
import { getRedis } from './redis.js';

const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30일

// ── 비밀번호 해시 (scrypt, 내장 crypto만 사용 — 새 의존성 없음) ──
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith('scrypt:')) return false;
  const [, salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// ── 비밀번호 양방향 암호화 (AES-256-GCM) ──
// 로그인 검증은 여전히 pwdHash(scrypt, 단방향)로 하고, 이 암호화는 "관리자가 다시 볼 수 있어야 하는"
// 평문 비밀번호를 DB에 그대로 두지 않기 위한 것. DB(Redis)만 유출되고 이 키(Vercel 환경변수)는
// 별도로 보호되는 한, 비밀번호는 노출되지 않는다.
const ENC_PREFIX = 'encv1:';

function getPwdEncKey() {
  const raw = process.env.PWD_ENC_KEY;
  if (!raw) throw new Error('PWD_ENC_KEY 환경변수가 설정되지 않았습니다');
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  // 임의 길이 문자열도 허용 — sha256으로 32바이트 키로 정규화
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptPwd(plain) {
  const key = getPwdEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

// 과거(마이그레이션 전) 데이터는 평문 그대로일 수 있어 encv1: 접두사가 없으면 그대로 반환(하위호환)
export function decryptPwd(stored) {
  if (!stored || typeof stored !== 'string') return stored || null;
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  try {
    const [ivHex, tagHex, dataHex] = stored.slice(ENC_PREFIX.length).split(':');
    const key = getPwdEncKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

// ── 세션 (Redis에 토큰의 sha256 해시를 키로 저장 — 원본 토큰 유출과 별개로 보호) ──
function tokenKey(token) {
  return 'session:' + crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(payload) {
  const redis = getRedis();
  const token = crypto.randomBytes(32).toString('hex');
  await redis.set(tokenKey(token), { ...payload, createdAt: Date.now() }, { ex: SESSION_TTL_SEC });
  return { token, maxAge: SESSION_TTL_SEC };
}

export async function getSession(token) {
  if (!token) return null;
  const redis = getRedis();
  const data = await redis.get(tokenKey(token));
  return data || null;
}

export async function deleteSession(token) {
  if (!token) return;
  const redis = getRedis();
  await redis.del(tokenKey(token));
}

// ── 쿠키 ──
const COOKIE_NAME = 'oheng_session';

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function getSessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

export function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// ── 최소 CSRF 방어: 상태 변경 요청의 Origin이 같은 배포 도메인인지 확인 ──
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 일부 구형 클라이언트/직접 API 테스트는 Origin이 없을 수 있어 통과시키되, 쿠키 기반이라 실제 공격 표면은 제한적
  try {
    const originHost = new URL(origin).host;
    const reqHost = req.headers.host;
    return originHost === reqHost;
  } catch {
    return false;
  }
}

// ── 범용 rate limit: 지정한 키가 windowSec 안에 limit회 초과 호출되면 false ──
export async function checkRateLimit(namespace, key, limit, windowSec) {
  const redis = getRedis();
  const rlKey = `rl:${namespace}:${key}`;
  const count = await redis.incr(rlKey);
  if (count === 1) await redis.expire(rlKey, windowSec);
  return count <= limit;
}

export async function checkLoginRateLimit(key) {
  return checkRateLimit('login', key, 10, 60); // 1분에 10회 초과 시 차단
}

// ── 관리자 계정 목록 (다중 계정, v2) ──
// admin:auth는 원래 단일 객체({id,pwdHash})였다가 다중 계정 지원을 위해
// {version, accounts:[{id,name,pwdHash,isMaster,...}]} 구조로 바뀌었다.
// 이 함수들이 v1/v2 차이를 흡수해서, 호출부는 항상 v2 모양만 다루면 된다.
export function normalizeAdminAccounts(raw) {
  if (!raw) return { version: 0, accounts: [] };
  if (Array.isArray(raw.accounts)) {
    return { version: raw.version || 0, accounts: raw.accounts };
  }
  if (raw.id && raw.pwdHash) {
    // v1: 단일 계정 객체 — 마스터 계정 하나로 승격.
    // 이 normalize는 getAdminAccounts()가 호출될 때마다(요청마다) 매번 다시 실행되므로,
    // 여기서 new Date()로 매번 새 타임스탬프를 만들면 호출할 때마다 값이 달라진다 — 로그인
    // 시 세션에 찍힌 passwordChangedAt과, 그다음 요청에서 다시 계산된 값이 서로 달라져
    // requireAdminSession의 비밀번호-변경 검사가 방금 로그인한 세션까지 즉시 무효화해버리는
    // 버그가 있었다(Codex 리뷰에서 지적됨). 값이 없을 때는 항상 같은 고정값을 써야 한다.
    const LEGACY_TS = '1970-01-01T00:00:00.000Z';
    return {
      version: 0,
      accounts: [{
        id: raw.id, name: raw.name || '원장님', pwdHash: raw.pwdHash, isMaster: true,
        createdAt: raw.createdAt || LEGACY_TS, updatedAt: raw.updatedAt || LEGACY_TS, passwordChangedAt: raw.passwordChangedAt || LEGACY_TS,
      }],
    };
  }
  return { version: 0, accounts: [] };
}

export async function getAdminAccounts() {
  const redis = getRedis();
  const raw = await redis.get('admin:auth');
  return normalizeAdminAccounts(raw);
}

// 버전 확인과 쓰기를 각각 별도 명령으로 하면(GET 후 조건부 SET) 그 사이에 다른 요청이
// 끼어들어 똑같이 버전 확인을 통과해버릴 수 있다 — 두 요청 모두 "성공"으로 응답하지만
// 나중 쓰기가 먼저 쓴 변경을 조용히 덮어쓴다(Codex 리뷰에서 지적됨). Lua 스크립트는 Redis
// 서버에서 통째로 원자적으로 실행되므로, 확인과 쓰기 사이에 다른 요청이 끼어들 수 없다.
const CAS_SET_SCRIPT = `
  local key = KEYS[1]
  local expectedVersion = tonumber(ARGV[1])
  local raw = redis.call('GET', key)
  local current = 0
  if raw then
    local ok, decoded = pcall(cjson.decode, raw)
    if ok and decoded and decoded.version then current = decoded.version end
  end
  if current ~= expectedVersion then
    return -1
  end
  redis.call('SET', key, ARGV[2])
  return 1
`;

export async function setAdminAccounts(accounts, expectedVersion) {
  const redis = getRedis();
  const next = { version: expectedVersion + 1, accounts };
  const result = await redis.eval(CAS_SET_SCRIPT, ['admin:auth'], [expectedVersion, JSON.stringify(next)]);
  if (result !== 1) {
    const err = new Error('admin accounts version conflict');
    err.code = 'VERSION_CONFLICT';
    throw err;
  }
  return next;
}

// ── 조교 가입 대기 목록 (Redis Hash: field=아이디, value=신청 정보) ──
// 배열 하나를 통째로 get/set하는 낙관적 락은 "현재 버전 확인 → 쓰기" 사이에 여전히 경쟁
// 구간이 남아 두 요청이 동시에 들어오면 나중 쓰기가 먼저 쓴 내용을 덮어쓸 수 있다(Codex
// 리뷰에서 지적됨). HSETNX/HDEL은 Redis 서버에서 필드 단위로 원자적으로 처리되므로 이
// 경쟁 상태 자체가 생기지 않는다.
export async function listPendingTaRequests() {
  const redis = getRedis();
  const map = await redis.hgetall('ta:pending');
  return map ? Object.values(map) : [];
}

// 같은 아이디로 이미 신청이 있으면 아무것도 바꾸지 않고 false를 반환 — 원자적이라 동시에
// 들어온 두 신청 중 하나만 통과한다.
export async function addPendingTaRequest(entry) {
  const redis = getRedis();
  const added = await redis.hsetnx('ta:pending', entry.id, entry);
  return added === 1;
}

export async function removePendingTaRequest(id) {
  const redis = getRedis();
  await redis.hdel('ta:pending', id);
}

// 승인 처리 전용: 읽기+삭제를 Lua 스크립트로 묶어 Redis 서버에서 원자적으로 처리한다.
// 별도의 HGET 다음 HDEL 두 번의 명령으로 하면, 그 사이에 거절→같은 아이디로 재신청이
// 끼어들어 방금 들어온 새 신청을 지우면서 예전(이미 사라진) 신청 데이터로 승인해버릴 수
// 있다(Codex 리뷰에서 지적됨). Lua 스크립트는 통째로 한 번에 실행되어 그 사이에 다른
// 명령이 끼어들 수 없다.
const CLAIM_SCRIPT = `
  local val = redis.call('HGET', KEYS[1], ARGV[1])
  if val == false then return false end
  redis.call('HDEL', KEYS[1], ARGV[1])
  return val
`;
export async function claimPendingTaRequest(id) {
  const redis = getRedis();
  const raw = await redis.eval(CLAIM_SCRIPT, ['ta:pending'], [id]);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

export function findAdminAccount(accounts, id) {
  const norm = String(id || '').trim().toLowerCase();
  return accounts.find(a => a.id === norm) || null;
}

// ── 조교 공지사항 (Redis Hash: field=공지 id, value=공지 내용) ──
// 배열을 통째로 get/set하던 이전 방식은 두 원장님 계정이 거의 동시에 글을 쓰거나 작성/삭제가
// 겹치면 나중 쓰기가 먼저 쓴 내용을 지워버릴 수 있었다(Codex 리뷰에서 지적됨). 공지마다 고유
// id를 필드로 쓰는 Hash로 바꾸면 작성은 항상 새 필드에 쓰는 것이라 애초에 충돌이 없고,
// 삭제도 필드 단위 HDEL이라 원자적이다.
export async function listTaNotices(limit = 50) {
  const redis = getRedis();
  const map = await redis.hgetall('ta:notices');
  const all = map ? Object.values(map) : [];
  all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return limit ? all.slice(0, limit) : all;
}

export async function addTaNotice(entry) {
  const redis = getRedis();
  await redis.hset('ta:notices', { [entry.id]: entry });
  return entry;
}

export async function removeTaNotice(id) {
  const redis = getRedis();
  await redis.hdel('ta:notices', id);
}

// 요청 쿠키의 세션이 유효한 관리자 세션인지 확인 — 아니면 null
export async function requireAdminSession(req) {
  const token = getSessionToken(req);
  const session = await getSession(token);
  if (!session || session.role !== 'admin') return null;
  // 다중 계정 로그인 도입 이후로는 관리자 세션이 항상 actorId를 갖고 생성된다 — actorId가
  // 없는 세션은 그 이전(단일 관리자 계정 시절)에 만들어진 것이므로, 계정 삭제/비밀번호
  // 변경 검증을 우회하지 못하도록 더 이상 유효한 관리자 세션으로 인정하지 않는다
  // (Codex 리뷰에서 지적됨).
  if (!session.actorId) return null;
  // 세션 자체는 아직 만료 전(최대 30일)이라도, 그 사이에 원장님이 해당 조교 계정을
  // 삭제했다면 더 이상 유효하지 않아야 한다 — 매 요청마다 계정이 실제로 남아있는지
  // 확인한다(Codex 리뷰에서 지적됨: 계정 삭제가 기존 세션을 무효화하지 않던 문제).
  const { accounts } = await getAdminAccounts();
  const account = findAdminAccount(accounts, session.actorId);
  if (!account) return null;
  // 비밀번호를 재설정(예: 유출 의심)해도 기존 로그인 세션이 30일 만료 전까지 그대로
  // 유효했던 문제(Codex 리뷰) — 세션 생성 시점의 passwordChangedAt과 계정의 현재 값이
  // 다르면(비번이 그 이후 바뀌었다는 뜻) 그 세션은 더 이상 인정하지 않는다. 이 필드가
  // 없던 예전 세션(이 수정 배포 이전에 로그인한 세션)도 안전하게 다시 로그인하도록
  // 일괄 무효화된다.
  if (session.passwordChangedAt !== account.passwordChangedAt) return null;
  return session;
}

// 요청 쿠키의 세션이 유효한 학생 세션인지 확인 — 아니면 null
export async function requireStudentSession(req) {
  const token = getSessionToken(req);
  const session = await getSession(token);
  if (!session || session.role !== 'student' || !session.studentId || !session.schoolId) return null;
  return session;
}

// 요청 쿠키의 세션이 유효한 일반 회원(휴대폰 인증) 세션인지 확인 — 아니면 null
export async function requireMemberSession(req) {
  const token = getSessionToken(req);
  const session = await getSession(token);
  if (!session || session.role !== 'member' || !session.memberId) return null;
  return session;
}

// 관리자 세션 또는 기존 API_AUTH_TOKEN(운영/스크립트용) 중 하나라도 유효하면 통과.
// 세션이 없을 땐 {role:'admin', viaApiToken:true}를 반환해 호출부가 동일하게 다룰 수 있게 함.
export async function requireAdminSessionOrApiToken(req) {
  const session = await requireAdminSession(req);
  if (session) return session;
  if (process.env.API_AUTH_TOKEN && req.headers['x-api-token'] === process.env.API_AUTH_TOKEN) {
    return { role: 'admin', viaApiToken: true };
  }
  return null;
}

// 마스터 전용 액션에서 사용 — 세션에 박제된 isMaster 값만 믿지 않고, Redis의 현재 계정
// 목록에서 실제로 그 계정이 존재하고 아직 isMaster인지 다시 확인한다(계정 삭제/권한
// 변경 이후에도 오래된 세션이 유효할 수 있으므로).
export async function requireMasterAdminSession(req) {
  const session = await requireAdminSession(req);
  if (!session || session.isMaster !== true || !session.actorId) return null;
  const { accounts } = await getAdminAccounts();
  const account = findAdminAccount(accounts, session.actorId);
  if (!account || account.isMaster !== true) return null;
  return session;
}

// API_AUTH_TOKEN 보유자는 이미 credentials/migrate 등 다른 모든 관리자 액션을 무제한으로
// 쓸 수 있으므로, 조교 계정 관리도 동일하게 마스터 권한과 동등하게 취급한다.
export async function requireMasterAdminSessionOrApiToken(req) {
  if (process.env.API_AUTH_TOKEN && req.headers['x-api-token'] === process.env.API_AUTH_TOKEN) {
    return { role: 'admin', viaApiToken: true, isMaster: true };
  }
  return requireMasterAdminSession(req);
}

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
