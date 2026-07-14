import { getRedis } from '../_lib/redis.js';
import { hashPassword } from '../_lib/auth.js';
import { putSchoolRaw, getSchoolIndex, getSchool } from '../_lib/school.js';

const MAX_BODY_CHARS = 5_000_000; // 5MB — 학교 규모상 충분히 넉넉한 상한

function isAuthorized(req) {
  return !!process.env.API_AUTH_TOKEN && req.headers['x-api-token'] === process.env.API_AUTH_TOKEN;
}

function validateShape(body) {
  if (!body || typeof body !== 'object') return '요청 본문이 올바르지 않습니다';
  if (!Array.isArray(body.schools)) return 'schools 배열이 없습니다';
  for (const sc of body.schools) {
    if (!sc.id || !sc.name || !Array.isArray(sc.students) || !Array.isArray(sc.records)) {
      return `학교 데이터 형식 오류: ${sc?.id || '(id 없음)'}`;
    }
  }
  return null;
}

function maxStudentIdSuffix(schools) {
  let max = 0;
  schools.forEach(sc => {
    (sc.students || []).forEach(s => {
      const m = /^s(\d+)$/.exec(s.id || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
  });
  return max;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const raw = JSON.stringify(req.body || {});
  if (raw.length > MAX_BODY_CHARS) {
    return res.status(413).json({ success: false, message: '업로드 데이터가 너무 큽니다' });
  }

  const shapeError = validateShape(req.body);
  if (shapeError) return res.status(400).json({ success: false, message: shapeError });

  const { schools, adminId, adminPwd } = req.body;
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';

  const studentCount = schools.reduce((sum, sc) => sum + (sc.students?.length || 0), 0);

  if (dryRun) {
    return res.status(200).json({
      success: true,
      dryRun: true,
      schoolsFound: schools.length,
      studentsFound: studentCount,
      willSetAdminId: adminId || 'admin',
    });
  }

  const redis = getRedis();

  // 실행 전 기존 서버 상태 백업 (문제 시 이 키를 참고해 수동 복구 가능)
  try {
    const existingIndex = await getSchoolIndex();
    if (existingIndex.length) {
      const existingSchools = await Promise.all(existingIndex.map(id => getSchool(id)));
      const existingAdmin = await redis.get('admin:auth');
      await redis.set(`backup:migrate:${Date.now()}`, {
        schools: existingSchools.filter(Boolean),
        admin: existingAdmin || null,
      }, { ex: 60 * 60 * 24 * 90 }); // 백업은 90일 보관 후 자동 삭제
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: '기존 데이터 백업 중 오류: ' + e.message });
  }

  // 관리자 자격 증명 해싱 적재
  await redis.set('admin:auth', {
    id: (adminId || 'admin').toLowerCase(),
    pwdHash: hashPassword(adminPwd || 'oheng2024'),
  });

  // 학교별 적재 (비밀번호 해싱 포함) + 인덱스 재구성
  for (const sc of schools) {
    await putSchoolRaw(sc);
  }
  await redis.set('school:index', schools.map(sc => sc.id));

  // 신규 학생 ID 채번 카운터 시드
  await redis.set('cnt:studentId', maxStudentIdSuffix(schools));

  return res.status(200).json({
    success: true,
    dryRun: false,
    schoolsImported: schools.length,
    studentsHashed: studentCount,
  });
}
