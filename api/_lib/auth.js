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

// 요청 쿠키의 세션이 유효한 관리자 세션인지 확인 — 아니면 null
export async function requireAdminSession(req) {
  const token = getSessionToken(req);
  const session = await getSession(token);
  if (!session || session.role !== 'admin') return null;
  return session;
}

// 요청 쿠키의 세션이 유효한 학생 세션인지 확인 — 아니면 null
export async function requireStudentSession(req) {
  const token = getSessionToken(req);
  const session = await getSession(token);
  if (!session || session.role !== 'student' || !session.studentId || !session.schoolId) return null;
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

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
