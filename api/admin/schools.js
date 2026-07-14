import { requireAdminSessionOrApiToken, isSameOrigin } from '../_lib/auth.js';
import { getSchoolIndex, getSchool, createSchool } from '../_lib/school.js';

export default async function handler(req, res) {
  const session = await requireAdminSessionOrApiToken(req);
  if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (req.method === 'GET') {
    const index = await getSchoolIndex();
    const schools = await Promise.all(index.map(async id => {
      const sc = await getSchool(id);
      if (!sc) return null;
      return {
        id: sc.id, name: sc.name, grade: sc.grade,
        studentCount: (sc.students || []).length,
        recordCount: (sc.records || []).length,
      };
    }));
    return res.status(200).json({ success: true, schools: schools.filter(Boolean) });
  }

  if (req.method === 'POST') {
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { name, grade } = req.body || {};
    if (!name) return res.status(400).json({ success: false, message: '학교 이름을 입력하세요' });
    const school = await createSchool(name, grade);
    return res.status(200).json({ success: true, school: { id: school.id, name: school.name, grade: school.grade, studentCount: 0, recordCount: 0 } });
  }

  return res.status(405).end();
}
