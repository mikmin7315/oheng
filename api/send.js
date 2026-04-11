const { SolapiMessageService } = require('solapi');

const messageService = new SolapiMessageService(
  'NCSIVKDMSKTDCSKV',
  'SGSN3EMLV0HWYGM81ORPUPHHUDFZSWMG'
);

const SENDER = '01090080851';
const PFID = 'KA01PF260409120809915UFtRoM8Y2O1';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }
  try {
    const { templateCode, to, variables } = req.body;
    const phone = to.replace(/[^0-9]/g, '');

    // 변수 키를 #{변수명} 형식으로 변환
    const params = {};
    if (variables) {
      Object.entries(variables).forEach(([key, value]) => {
        // 이미 #{} 형식이면 그대로, 아니면 추가
        const formattedKey = key.startsWith('#{') ? key : `#{${key}}`;
        params[formattedKey] = String(value);
      });
    }

    console.log('Send request:', JSON.stringify({ phone, templateCode, params }));

    const result = await messageService.send({
      to: phone,
      from: SENDER,
      kakaoOptions: {
        pfId: PFID,
        templateId: templateCode,
        variables: params
      }
    });

    console.log('Send result:', JSON.stringify(result));
    return res.status(200).json({ success: true, data: result });

  } catch (error) {
    console.error('Error:', error.message, JSON.stringify(error));
    return res.status(500).json({ success: false, message: error.message });
  }
}
