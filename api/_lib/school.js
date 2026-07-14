import { getRedis } from './redis.js';
import { hashPassword, verifyPassword } from './auth.js';

const SCHOOL_PREFIX = 'school:';
const INDEX_KEY = 'school:index';

export class VersionConflictError extends Error {}

export async function getSchoolIndex() {
  const redis = getRedis();
  const idx = await redis.get(INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

export async function addToSchoolIndex(id) {
  const redis = getRedis();
  const idx = await getSchoolIndex();
  if (!idx.includes(id)) {
    idx.push(id);
    await redis.set(INDEX_KEY, idx);
  }
}

export async function getSchool(id) {
  const redis = getRedis();
  return await redis.get(SCHOOL_PREFIX + id);
}

export async function removeFromSchoolIndex(id) {
  const redis = getRedis();
  const idx = await getSchoolIndex();
  const next = idx.filter(x => x !== id);
  await redis.set(INDEX_KEY, next);
}

export async function deleteSchool(id) {
  const redis = getRedis();
  await redis.del(SCHOOL_PREFIX + id);
  await removeFromSchoolIndex(id);
}

export async function createSchool(name, grade) {
  const id = 'sch' + Date.now();
  const school = {
    id, name, grade: grade || '1학년',
    students: [], records: [], notices: {}, suggestions: [],
    hw1: '숙제1', hw2: '숙제2', hw2Skip: false, hwNames: {}, kakaoChannel: '',
    version: 1,
  };
  school._aggregates = computeAggregates(school);
  const redis = getRedis();
  await redis.set(SCHOOL_PREFIX + id, school);
  await addToSchoolIndex(id);
  return school;
}

// index.html의 calcTotalAvg()+classCount() 로직을 서버에서 그대로 재현.
// 두 클라이언트 함수를 고칠 때는 여기도 같이 맞춰야 한다 (공유 모듈 시스템이 없어 부득이 복제됨).
export function computeAggregates(school) {
  const records = school.records || [];
  const weeks = [...new Set(records.map(r => r.month + '_' + r.week))];
  const aggregates = {};
  weeks.forEach(wk => {
    const [month, week] = wk.split('_');
    const valid = records.filter(r => r.month === month && r.week === week &&
      (r.rtSkip || r.rtScore != null) && (r.wtSkip || r.wtScore != null) &&
      ((!r.rtSkip && r.rtScore != null) || (!r.wtSkip && r.wtScore != null)));
    if (!valid.length) { aggregates[wk] = { avg: null, count: 0 }; return; }
    const tots = valid.map(r => (r.rtSkip ? 0 : (r.rtScore || 0)) + (r.wtSkip ? 0 : (r.wtScore || 0)));
    const avg = Math.round(tots.reduce((a, b) => a + b, 0) / tots.length * 10) / 10;
    aggregates[wk] = { avg, count: valid.length };
  });
  return aggregates;
}

// 관리자가 PUT으로 보낸 학교 blob을 신뢰 가능한 형태로 정규화.
// - id는 서버 기존값 고정 (변조 방지)
// - 기존 학생의 pwdHash는 서버에 저장된 값 유지 (클라이언트가 보낸 pwd/pwdHash 무시 — 비밀번호 변경은 전용 재설정 엔드포인트로만)
// - 신규 학생(기존에 없던 id)은 클라이언트가 보낸 평문 pwd를 서버가 해싱하고 평문은 저장하지 않음
export function normalizeSchoolForWrite(incoming, existing) {
  const existingStudentsById = new Map((existing?.students || []).map(s => [s.id, s]));
  const students = (incoming.students || []).map(s => {
    const prev = existingStudentsById.get(s.id);
    const { pwd, pwdHash, ...rest } = s;
    if (prev) return { ...rest, pwdHash: prev.pwdHash };
    return { ...rest, pwdHash: hashPassword(pwd || '1234') };
  });

  return {
    id: existing?.id || incoming.id,
    name: incoming.name,
    grade: incoming.grade,
    students,
    records: Array.isArray(incoming.records) ? incoming.records : [],
    notices: incoming.notices || {},
    suggestions: Array.isArray(incoming.suggestions) ? incoming.suggestions : (existing?.suggestions || []),
    hw1: incoming.hw1 || '숙제1',
    hw2: incoming.hw2 || '숙제2',
    hw2Skip: !!incoming.hw2Skip,
    hwNames: incoming.hwNames || {},
    kakaoChannel: incoming.kakaoChannel || '',
  };
}

// 마이그레이션 전용: 백업 JSON의 모든 학생 평문 비밀번호를 해싱 (신규/기존 구분 없이 전체 최초 적재)
export function hashSchoolForMigration(school) {
  const students = (school.students || []).map(s => {
    const { pwd, ...rest } = s;
    return { ...rest, pwdHash: hashPassword(pwd || '1234') };
  });
  return {
    id: school.id,
    name: school.name,
    grade: school.grade,
    students,
    records: Array.isArray(school.records) ? school.records : [],
    notices: school.notices || {},
    suggestions: Array.isArray(school.suggestions) ? school.suggestions : [],
    hw1: school.hw1 || '숙제1',
    hw2: school.hw2 || '숙제2',
    hw2Skip: !!school.hw2Skip,
    hwNames: school.hwNames || {},
    kakaoChannel: school.kakaoChannel || '',
  };
}

// 버전 체크(낙관적 락) 포함 저장. expectedVersion이 서버 현재값과 다르면 VersionConflictError.
export async function saveSchool(id, incoming, expectedVersion) {
  const redis = getRedis();
  const existing = await getSchool(id);
  const currentVersion = existing?.version || 0;
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== currentVersion) {
    throw new VersionConflictError(`버전 충돌: 서버=${currentVersion}, 요청=${expectedVersion}`);
  }
  const normalized = normalizeSchoolForWrite(incoming, existing);
  normalized.version = currentVersion + 1;
  normalized._aggregates = computeAggregates(normalized);
  await redis.set(SCHOOL_PREFIX + id, normalized);
  return normalized;
}

// 마이그레이션 전용 저장 — 버전 체크 없이 최초 적재 (기존 서버 데이터를 그대로 덮어씀, migrate.js에서 사전 백업 후 호출)
export async function putSchoolRaw(school) {
  const redis = getRedis();
  const normalized = hashSchoolForMigration(school);
  normalized.version = 1;
  normalized._aggregates = computeAggregates(normalized);
  await redis.set(SCHOOL_PREFIX + school.id, normalized);
  await addToSchoolIndex(school.id);
  return normalized;
}

// 학생 id+pw로 전체 학교를 훑어 일치하는 학생을 찾는다 (로그인용). 아이디는 전역 유니크 가정.
export async function findStudentByCredentials(id, pw) {
  const normId = String(id).trim().toLowerCase();
  const index = await getSchoolIndex();
  for (const schoolId of index) {
    const sc = await getSchool(schoolId);
    if (!sc) continue;
    const student = (sc.students || []).find(s => String(s.id).toLowerCase() === normId);
    if (student && verifyPassword(pw, student.pwdHash)) {
      return { schoolId, studentId: student.id };
    }
  }
  return null;
}

// 관리자용 응답에서도 pwdHash는 절대 내려보내지 않음 (관리자 화면은 "재설정"만 가능, "보기" 불가)
export function toAdminView(school) {
  if (!school) return null;
  return {
    ...school,
    students: (school.students || []).map(({ pwdHash, ...rest }) => rest),
  };
}
