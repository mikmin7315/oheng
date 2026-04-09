export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const PPURIO_KEY = '158351788fe73fbc1af3e42465165e3fc3bf9179753af092a41fe82a523a4cbc';

  try {
    const body = req.body;
    const response = await fetch('https://api.ppurio.com/v1/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + PPURIO_KEY
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (response.ok) {
      return res.status(200).json({ success: true, data });
    } else {
      return res.status(response.status).json({ success: false, message: data.message || '발송 실패', data });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}
