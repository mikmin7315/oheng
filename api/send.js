const PPURIO_ACCOUNT = 'gloatingly';
const PPURIO_KEY = '158351788fe73fbc1af3e42465165e3fc3bf9179753af092a41fe82a523a4cbc';
const PPURIO_SENDER_PROFILE = '@오은실영어랩';

async function getToken() {
  // 계정:인증키 → Base64
  const credentials = Buffer.from(`${PPURIO_ACCOUNT}:${PPURIO_KEY}`).toString('base64');
  const res = await fetch('https://message.ppurio.com/v1/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`
    }
  });
  const text = await res.text();
  console.log('Token status:', res.status, text);
  const data = JSON.parse(text);
  return data.token || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }
  try {
    const { templateCode, to, variables } = req.body;

    // 1단계: 토큰 발급
    const token = await getToken();
    if (!token) return res.status(401).json({ success: false, message: '토큰 발급 실패' });

    // 치환문자 변환
    const changeWord = {};
    if (variables) {
      Object.entries(variables).forEach(([key, value]) => {
        changeWord[key] = String(value);
      });
    }

    // 2단계: 알림톡 발송
    const sendData = {
      account: PPURIO_ACCOUNT,
      messageType: 'ALI',
      senderProfile: PPURIO_SENDER_PROFILE,
      templateCode: templateCode,
      duplicateFlag: 'N',
      targetCount: 1,
      targets: [{ to: to.replace(/[^0-9]/g, ''), changeWord }],
      isResend: 'N'
    };

    const sendRes = await fetch('https://message.ppurio.com/v1/kakao', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sendData)
    });

    const resultText = await sendRes.text();
    console.log('Send status:', sendRes.status, resultText);
    const result = JSON.parse(resultText);

    if (sendRes.ok) return res.status(200).json({ success: true, data: result });
    return res.status(sendRes.status).json({ success: false, message: result.description || result.message || '발송 실패', data: result });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}
