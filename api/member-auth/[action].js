import {
  createSession, setSessionCookie, checkRateLimit, isSameOrigin, getClientIp,
  getSessionToken, getSession, deleteSession, clearSessionCookie, requireMemberSession,
} from '../_lib/auth.js';
import { generateOtpCode, storeOtp, verifyOtp } from '../_lib/otp.js';
import { findOrCreateMemberByPhone, updateMemberName, getMember } from '../_lib/member.js';
import { sendPlainSms } from '../_lib/sms.js';

function normalizePhone(raw) {
  return String(raw || '').replace(/[^0-9]/g, '');
}

export default async function handler(req, res) {
  const { action } = req.query;

  if (action === 'otp-request') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const phone = normalizePhone(req.body?.phone);
    if (phone.length < 10) return res.status(400).json({ success: false, message: '휴대폰 번호를 확인해주세요' });

    const phoneOk = await checkRateLimit('otp-req-phone', phone, 5, 3600);
    const ipOk = await checkRateLimit('otp-req-ip', getClientIp(req), 10, 3600);
    if (!phoneOk || !ipOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const code = generateOtpCode();
    await storeOtp(phone, code);
    try {
      await sendPlainSms(phone, `[OHENG] 인증번호는 ${code} 입니다. 3분 내에 입력해주세요.`);
    } catch (e) {
      console.error('sendPlainSms failed:', e?.message || e);
      console.error('sendPlainSms error keys:', Object.keys(e || {}));
      console.error('sendPlainSms error dump:', JSON.stringify(e, Object.getOwnPropertyNames(e || {})));
      if (e?.failedMessageList) console.error('failedMessageList:', JSON.stringify(e.failedMessageList));
      return res.status(500).json({ success: false, message: '인증번호 발송에 실패했습니다' });
    }
    return res.status(200).json({ success: true });
  }

  if (action === 'otp-verify') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!phone || !code) return res.status(400).json({ success: false, message: '휴대폰 번호와 인증번호를 입력하세요' });

    const result = await verifyOtp(phone, code);
    if (!result.ok) {
      const msg = result.reason === 'too_many_attempts' ? '인증 시도 횟수를 초과했습니다. 인증번호를 다시 받아주세요'
        : result.reason === 'expired' ? '인증번호가 만료되었습니다. 다시 받아주세요'
        : '인증번호가 일치하지 않습니다';
      return res.status(400).json({ success: false, message: msg });
    }

    const { member, isNew } = await findOrCreateMemberByPhone(phone);
    const { token, maxAge } = await createSession({ role: 'member', memberId: member.id });
    setSessionCookie(res, token, maxAge);
    return res.status(200).json({ success: true, isNew, name: member.name || '' });
  }

  if (action === 'profile') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const session = await requireMemberSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: '이름을 입력하세요' });
    await updateMemberName(session.memberId, name);
    return res.status(200).json({ success: true });
  }

  if (action === 'me') {
    if (req.method !== 'GET') return res.status(405).end();
    const session = await requireMemberSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const member = await getMember(session.memberId);
    if (!member) return res.status(404).json({ success: false, message: '회원 정보를 찾을 수 없습니다' });
    return res.status(200).json({ success: true, member: { id: member.id, phone: member.phone, name: member.name } });
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
