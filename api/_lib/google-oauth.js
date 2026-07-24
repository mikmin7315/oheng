import crypto from 'crypto';
import { getRedis } from './redis.js';

const STATE_PREFIX = 'oauth_state:google:';
const STATE_TTL_SEC = 600;

function redirectUri(req) {
  return `https://${req.headers.host}/api/member-auth/google-callback`;
}

// CSRF 방지용 1회성 state — Redis에 잠깐 저장해두고 콜백에서 소모(삭제)한다.
export async function createOauthState() {
  const redis = getRedis();
  const state = crypto.randomBytes(24).toString('hex');
  await redis.set(STATE_PREFIX + state, true, { ex: STATE_TTL_SEC });
  return state;
}

export async function consumeOauthState(state) {
  if (!state) return false;
  const redis = getRedis();
  const key = STATE_PREFIX + state;
  const exists = await redis.get(key);
  if (!exists) return false;
  await redis.del(key);
  return true;
}

export function buildGoogleAuthUrl(req, state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(req, code) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error('구글 인증 코드 교환 실패: ' + (await res.text()).slice(0, 200));
  return res.json();
}

export async function fetchGoogleProfile(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('구글 프로필 조회 실패');
  const data = await res.json();
  return { googleId: data.sub, email: data.email || '', name: data.name || '', avatarUrl: data.picture || '' };
}
