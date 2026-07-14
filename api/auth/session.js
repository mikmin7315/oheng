import { getSessionToken, getSession } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const token = getSessionToken(req);
  const session = await getSession(token);
  if (!session) return res.status(401).json({ success: false, message: '세션이 없습니다' });

  return res.status(200).json({ success: true, role: session.role });
}
