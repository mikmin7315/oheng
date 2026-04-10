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

    console.log('Send request:', { templateCode, phone, variables });

    const params = {};
    if (variables) {
      Object.entries(variables).forEach(([key, value]) => {
        params[key] = String(value);
      });
    }

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
    console.error('Error:', error.message, error);
    return res.status(500).json({ success: false, message: error.message });
  }
}
