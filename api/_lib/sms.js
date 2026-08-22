const { SolapiMessageService } = require('solapi');

const messageService = new SolapiMessageService(
  process.env.SOLAPI_API_KEY,
  process.env.SOLAPI_API_SECRET
);

const SENDER = process.env.SOLAPI_SENDER || '01090080851';
// 인강(oheng.co.kr) 사이트는 기존 학원 카카오 채널(SOLAPI_PFID)과 완전히 분리된
// 독립 브랜드라, 별도의 카카오톡 채널/PFID를 새로 만들어 쓴다.
const LECTURE_PFID = process.env.SOLAPI_LECTURE_PFID;
const OTP_TEMPLATE_ID = process.env.SOLAPI_OTP_TEMPLATE_ID;

// 알림톡 템플릿(api/send.js)과 달리 kakaoOptions 없이 호출하면 일반 SMS/LMS로 즉시 발송된다
// (솔라피가 텍스트 길이 보고 SMS/LMS 자동 판단, 사전 템플릿 승인 불필요).
export async function sendPlainSms(to, text) {
  const phone = String(to).replace(/[^0-9]/g, '');
  return messageService.send({ to: phone, from: SENDER, text });
}

// 인증번호 발송 전용 — SOLAPI_LECTURE_PFID(인강 전용 채널)와 SOLAPI_OTP_TEMPLATE_ID가
// 모두 설정되면 카카오 알림톡으로 먼저 시도하고(disableSms:false라 실패 시 자동으로
// 문자로 대체발송됨), 채널/템플릿이 아직 없으면(승인 전) 지금처럼 일반 문자로 바로 보낸다 —
// 승인 후 환경변수만 추가하면 배포 없이 전환된다.
// 일반 SMS는 발신번호 스팸 필터링으로 배달이 조용히 실패하는 경우가 있어 알림톡이 더 안정적.
export async function sendOtpMessage(to, code) {
  const phone = String(to).replace(/[^0-9]/g, '');
  const text = `[OHENG] 인증번호는 ${code} 입니다. 3분 내에 입력해주세요.`;
  if (OTP_TEMPLATE_ID && LECTURE_PFID) {
    return messageService.send({
      to: phone, from: SENDER, text,
      kakaoOptions: { pfId: LECTURE_PFID, templateId: OTP_TEMPLATE_ID, variables: { '#{인증번호}': code }, disableSms: false },
    });
  }
  return messageService.send({ to: phone, from: SENDER, text });
}

// 발송 자체(send)는 성공해도 실제 통신사 배달까지 성공했다는 보장은 아님 —
// 배달 상태(성공/실패 사유)를 나중에 조회해 디버깅할 때 사용.
export async function getMessageHistory(to, limit = 10) {
  const phone = String(to).replace(/[^0-9]/g, '');
  return messageService.getMessages({ to: phone, limit });
}
