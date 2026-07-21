import crypto from 'crypto';
import { getRedis } from './redis.js';

const OTP_PREFIX = 'otp:';
const OTP_TTL_SEC = 180;
const MAX_ATTEMPTS = 5;

export function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export async function storeOtp(phone, code) {
  const redis = getRedis();
  await redis.set(OTP_PREFIX + phone, { code, attempts: 0 }, { ex: OTP_TTL_SEC });
}

// 성공 시 { ok: true }, 실패 시 사유와 함께 { ok: false, reason }.
// 5회 틀리면 코드 자체를 지워서 재요청(otp-request)을 다시 받도록 강제한다.
export async function verifyOtp(phone, code) {
  const redis = getRedis();
  const key = OTP_PREFIX + phone;
  const stored = await redis.get(key);
  if (!stored) return { ok: false, reason: 'expired' };
  if (stored.attempts >= MAX_ATTEMPTS) {
    await redis.del(key);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (String(stored.code) !== String(code)) {
    stored.attempts += 1;
    await redis.set(key, stored, { ex: OTP_TTL_SEC });
    return { ok: false, reason: 'mismatch' };
  }
  await redis.del(key);
  return { ok: true };
}
