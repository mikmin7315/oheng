import { getSchoolIndex, getSchool } from '../_lib/school.js';

// 개인정보 없이 학교별 요약만 반환하는 검증용 엔드포인트 (4단계에서 정식 조회 API로 대체 예정)
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!process.env.API_AUTH_TOKEN || req.headers['x-api-token'] !== process.env.API_AUTH_TOKEN) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const index = await getSchoolIndex();
  const summaries = await Promise.all(index.map(async id => {
    const sc = await getSchool(id);
    if (!sc) return { id, missing: true };
    return {
      id: sc.id,
      name: sc.name,
      grade: sc.grade,
      studentCount: (sc.students || []).length,
      recordCount: (sc.records || []).length,
      version: sc.version,
      hasHashedPasswords: (sc.students || []).every(s => typeof s.pwdHash === 'string' && s.pwdHash.startsWith('scrypt:')),
    };
  }));

  return res.status(200).json({ success: true, schoolIndex: index, schools: summaries });
}
