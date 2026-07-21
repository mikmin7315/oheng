const { SolapiMessageService } = require('solapi');

const messageService = new SolapiMessageService(
  process.env.SOLAPI_API_KEY,
  process.env.SOLAPI_API_SECRET
);

const SENDER = process.env.SOLAPI_SENDER || '01090080851';

// 알림톡 템플릿(api/send.js)과 달리 kakaoOptions 없이 호출하면 일반 SMS/LMS로 즉시 발송된다
// (솔라피가 텍스트 길이 보고 SMS/LMS 자동 판단, 사전 템플릿 승인 불필요).
export async function sendPlainSms(to, text) {
  const phone = String(to).replace(/[^0-9]/g, '');
  return messageService.send({ to: phone, from: SENDER, text });
}
