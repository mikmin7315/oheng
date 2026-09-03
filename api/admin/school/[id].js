import { requireAdminSessionOrApiToken, isSameOrigin } from '../../_lib/auth.js';
import { normalizeGrade } from '../../_lib/mock.js';
import { getSchool, saveSchool, deleteSchool, toAdminView, VersionConflictError } from '../../_lib/school.js';

export default async function handler(req, res) {
  const session = await requireAdminSessionOrApiToken(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ success: false, message: 'Missing id' });

  if (req.method === 'GET') {
    const sc = await getSchool(id);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    return res.status(200).json({ success: true, school: toAdminView(sc) });
  }

  if (req.method === 'PUT') {
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    try {
      const body = req.body || {};
      // 학년은 모의고사 회차와 반을 잇는 유일한 키라, 클라이언트 검증만 믿지 않고 서버에서도 정규화한다.
      // 정규화 결과가 빈 문자열이면 원래 값을 그대로 둔다(정규화가 값을 삼켜버리는 일 방지).
      const grade = normalizeGrade(body.grade) || body.grade;
      const updated = await saveSchool(id, { ...body, id, grade }, body.version);
      return res.status(200).json({ success: true, school: toAdminView(updated) });
    } catch (e) {
      if (e instanceof VersionConflictError) {
        const latest = await getSchool(id);
        return res.status(409).json({ success: false, message: e.message, school: toAdminView(latest) });
      }
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  if (req.method === 'DELETE') {
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    await deleteSchool(id);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}
