const SOLAPI_KEY = 'NCSIVKDMSKTDCSKV';
const SOLAPI_SECRET = 'SGSN3EMLV0HWYGM81ORPUPHHUDFZSWMG';
const SENDER = '01090080851';

function makeSignature() {
  const crypto = require('crypto');
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 12);
  const hmac = crypto.createHmac('sha256', SOLAPI_SECRET);
  hmac.update(`${date}${salt}`);
  const signature = hmac.digest('hex');
  return { date, salt, signature };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }
  try {
    const { templateCode, to, variables } = req.body;
    const { date, salt, signature } = makeSignature();

    // 알림톡 템플릿 심사 전: SMS로 대체 발송
    const isTest = !templateCode || templateCode === 'test';

    let messageBody;

    if (isTest) {
      // SMS 테스트
      messageBody = {
        messages: [{
          to: to.replace(/[^0-9]/g, ''),
          from: SENDER,
          text: '[OHENG] API 연결 테스트 메시지입니다.'
        }]
      };
    } else {
      // 알림톡 (템플릿 심사 완료 후)
      const params = {};
      if (variables) {
        Object.entries(variables).forEach(([key, value]) => {
          params[key] = String(value);
        });
      }
      messageBody = {
        messages: [{
          to: to.replace(/[^0-9]/g, ''),
          from: SENDER,
          kakaoOptions: {
            pfId: '@오은실영어랩',
            templateId: templateCode,
            variables: params
          }
        }]
      };
    }

    console.log('Request:', JSON.stringify(messageBody));

    const sendRes = await fetch('https://api.solapi.com/messages/v4/send-many', {
      method: 'POST',
      headers: {
        'Authorization': `HMAC-SHA256 apiKey=${SOLAPI_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(messageBody)
    });

    const resultText = await sendRes.text();
    console.log('Response:', sendRes.status, resultText);
    const result = JSON.parse(resultText);

    if (sendRes.ok) return res.status(200).json({ success: true, data: result });
    return res.status(sendRes.status).json({ success: false, message: result.errorMessage || '발송 실패', data: result });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}
