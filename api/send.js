const PPURIO_ACCOUNT = 'gloatingly';
const PPURIO_KEY = '158351788fe73fbc1af3e42465165e3fc3bf9179753af092a41fe82a523a4cbc';
const PPURIO_SENDER_PROFILE = '@오은실영어랩';

async function getToken() {
  const credentials = Buffer.from(`${PPURIO_ACCOUNT}:${PPURIO_KEY}`).toString('base64');
  const res = await fetch('https://message.ppurio.com/v1/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}` }
  });
  const data = await res.json();
  return data.token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }
  try {
    const { templateCode, to, variables } = req.body;
    const token = await getToken();
    if (!token) return res.status(401).json({ success: false, message: '토큰 발급 실패' });

    const changeWord = {};
    if (variables) {
      Object.entries(variables).forEach(([key, value]) => { changeWord[key] = value; });
    }

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

    const result = await sendRes.json();
    if (sendRes.ok) return res.status(200).json({ success: true, data: result });
    return res.status(sendRes.status).json({ success: false, message: result.message || '발송 실패', data: result });

  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}
