import { Webhook } from '@portone/server-sdk';
import { verifyAndCompletePayment } from '../_lib/payment.js';

// 포트원 웹훅은 서명 검증을 위해 body를 파싱 전 원문(raw string) 그대로 써야 하므로
// Vercel 기본 body parser를 끄고 직접 읽는다.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// 사용자가 결제 성공 직후 브라우저를 닫아버려서 /api/courses/complete-payment가
// 호출되지 못하는 경우의 보험 — 포트원이 서버 대 서버로 알려주는 이 웹훅이 놓치지 않고 잡아준다.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await readRawBody(req);
  let webhook;
  try {
    webhook = await Webhook.verify(process.env.PORTONE_WEBHOOK_SECRET, rawBody, req.headers);
  } catch (e) {
    if (e instanceof Webhook.WebhookVerificationError) {
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }
    throw e;
  }

  const paymentId = webhook?.data?.paymentId;
  if (paymentId) {
    await verifyAndCompletePayment(paymentId).catch(() => {});
  }
  return res.status(200).json({ success: true });
}
