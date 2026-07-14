import { getSessionToken, deleteSession, clearSessionCookie } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = getSessionToken(req);
  await deleteSession(token);
  clearSessionCookie(res);

  return res.status(200).json({ success: true });
}
