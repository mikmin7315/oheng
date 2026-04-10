const SOLAPI_KEY = 'NCSIVKDMSKTDCSKV';
const SOLAPI_SECRET = 'SGSN3EMLV0HWYGM81ORPUPHHUDFZSWMG';
const SENDER = '01090080851';
const PFID = 'KA01PF260409120809915UFtRoM8Y2O1';

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

    const params = {};
    if (variables) {
      Object.entries(variables).forEach(([key, value]) => {
        params[key] = String(value);
      });
    }

    const body = {
      messages: [{
        to: to.replace(/[^0-9]/g, ''),
        from: SENDER,
        kakaoOptions: {
          pfId: PFID,
          templateId: templateCode,
          variables: params
        }
      }]
    };

    console.log('Request:', JSON.stringify(body));

    const sendRes = await fetch('https://api.solapi.com/messages/v4/send-many', {
      method: 'POST',
      headers: {
        'Authorization': `HMAC-SHA256 apiKey=${SOLAPI_KEY}, date=${date}, salt=${salt}, signature=${signature}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
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
