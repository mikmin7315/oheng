import { getRedis } from './redis.js';
import { hashPassword, verifyPassword, encryptPwd, decryptPwd } from './auth.js';

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

// 학교 목록 화면(GET /api/admin/schools)이 매번 학교 전체 블롭(수백 KB~1MB)을 전부 읽어와야
// 했던 게 느려진 핵심 원인이었다. 이름/인원수/성적건수 같은 가벼운 요약만 해시에 필드별로
// 캐시해두고, 목록 화면은 이 해시 하나만 통째로 읽게 한다(HGETALL 1회). 학교를 만들거나
// 저장할 때마다 그 학교 필드만 HSET으로 갱신(아래 세 함수) — 다른 학교 요약을 읽고 다시 쓸
// 필요가 없어 다른 학교 저장과 경쟁(레이스)할 일도 없다.
const SUMMARY_KEY = 'school:summary';

export function summarizeSchool(school) {
  return {
    id: school.id, name: school.name, grade: school.grade,
    type: school.type === 'lecture' ? 'lecture' : 'regular',
    studentCount: (school.students || []).length,
    recordCount: (school.records || []).length,
  };
}

export async function getSchoolSummaries() {
  const redis = getRedis();
  const map = await redis.hgetall(SUMMARY_KEY);
  if (!map) return [];
  // @upstash/redis의 해시 필드 자동 역직렬화 여부에 기대지 않고, 문자열로 오면 직접 파싱
  // (필드 값을 저장할 때도 JSON.stringify로 명시적으로 직렬화해서 이 파싱과 항상 짝을 맞춘다)
  return Object.values(map).map(v => {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  }).filter(Boolean);
}

export async function setSchoolSummaryEntry(entry) {
  const redis = getRedis();
  await redis.hset(SUMMARY_KEY, { [entry.id]: JSON.stringify(entry) });
}

export async function upsertSchoolSummary(school) {
  await setSchoolSummaryEntry(summarizeSchool(school));
}

export async function removeSchoolSummary(id) {
  const redis = getRedis();
  await redis.hdel(SUMMARY_KEY, id);
}

export async function deleteSchool(id) {
  const redis = getRedis();
  await redis.del(SCHOOL_PREFIX + id);
  await removeFromSchoolIndex(id);
  await removeSchoolSummary(id);
}

export async function createSchool(name, grade, type) {
  const id = 'sch' + Date.now();
  const school = {
    id, name, grade: grade || '1학년', type: type === 'lecture' ? 'lecture' : 'regular',
    students: [], records: [], notices: {}, suggestions: [], withdrawnStudents: [], inquiries: [], sendLogs: [], saveLogs: [],
    hw1: '숙제1', hw2: '숙제2', hw2Skip: false, hwNames: {}, kakaoChannel: '',
    version: 1,
  };
  school._aggregates = computeAggregates(school);
  const redis = getRedis();
  await redis.set(SCHOOL_PREFIX + id, school);
  await addToSchoolIndex(id);
  await upsertSchoolSummary(school);
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
// - 비밀번호는 암호화(pwd, AES-256-GCM)도 함께 저장해 관리자가 언제든 다시 확인/재발송할 수 있게 함
//   (로그인 검증에는 여전히 pwdHash를 사용 — 암호화된 pwd는 조회용, DB만 유출돼도 원문 노출 안 됨).
//   기존 학생의 비밀번호 변경은 전용 재설정 엔드포인트로만 가능하고, 일반 저장(PUT)에서는 기존 pwd/pwdHash를 그대로 유지.
// - 신규 학생(기존에 없던 id)은 클라이언트가 보낸 평문 pwd를 암호화해서 저장 + 해시도 함께 생성
export function normalizeSchoolForWrite(incoming, existing) {
  const existingStudentsById = new Map((existing?.students || []).map(s => [s.id, s]));
  const students = (incoming.students || []).map(s => {
    const prev = existingStudentsById.get(s.id);
    const { pwd, pwdHash, ...rest } = s;
    if (prev) return { ...rest, pwd: prev.pwd, pwdHash: prev.pwdHash };
    // 숫자만 허용 — 숫자가 아닌 문자가 섞여 들어오면 안전하게 무작위 4자리 숫자로 대체한다
    // (여기는 일반 학교 저장 경로라 400으로 거절하기보다 정제해서 저장을 막지 않는 쪽을 택함).
    const digitsOnly = String(pwd || '').replace(/\D/g, '');
    const initialPwd = digitsOnly || String(Math.floor(1000 + Math.random() * 9000));
    return { ...rest, pwd: encryptPwd(initialPwd), pwdHash: hashPassword(initialPwd) };
  });

  // 탈퇴 학생 목록도 학생과 동일하게 암호화된 pwd/pwdHash를 유지해야 한다. 관리자 화면은
  // pwd를 복호화된 평문으로 보여주므로, 여기서 손대지 않고 클라이언트가 보낸 값을 그대로
  // 저장하면 탈퇴 처리(단건/일괄) 시 비밀번호 평문이 그대로 Redis에 남는다(Codex 리뷰에서
  // 지적됨). 이미 탈퇴 목록에 있던 학생이면 그 암호화값을, 이번에 막 탈퇴 처리돼 방금까지
  // 재학생이었던 학생이면 재학 시절의 암호화값을 그대로 이어받아 복구했을 때도 로그인
  // 정보가 그대로 유지되게 한다.
  const existingWithdrawnById = new Map((existing?.withdrawnStudents || []).map(s => [s.id, s]));
  const withdrawnStudents = (Array.isArray(incoming.withdrawnStudents) ? incoming.withdrawnStudents : (existing?.withdrawnStudents || [])).map(s => {
    const prev = existingWithdrawnById.get(s.id) || existingStudentsById.get(s.id);
    const { pwd, pwdHash, ...rest } = s;
    if (prev) return { ...rest, pwd: prev.pwd, pwdHash: prev.pwdHash };
    const digitsOnly = String(pwd || '').replace(/\D/g, '');
    const initialPwd = digitsOnly || String(Math.floor(1000 + Math.random() * 9000));
    return { ...rest, pwd: encryptPwd(initialPwd), pwdHash: hashPassword(initialPwd) };
  });

  return {
    id: existing?.id || incoming.id,
    name: incoming.name,
    grade: incoming.grade,
    type: incoming.type === 'lecture' ? 'lecture' : (existing?.type === 'lecture' ? 'lecture' : 'regular'),
    students,
    records: Array.isArray(incoming.records) ? incoming.records : [],
    notices: incoming.notices || {},
    suggestions: Array.isArray(incoming.suggestions) ? incoming.suggestions : (existing?.suggestions || []),
    withdrawnStudents,
    inquiries: Array.isArray(incoming.inquiries) ? incoming.inquiries : (existing?.inquiries || []),
    // sendLogs는 전용 append/clear 엔드포인트로만 바뀜 — 일반 저장(PUT)에서는 클라이언트가 들고 있던
    // 오래된 값으로 덮어쓰지 않도록 항상 서버의 기존 값을 그대로 유지
    sendLogs: existing?.sendLogs || [],
    // saveLogs(성적 저장 로그)도 동일한 이유로 전용 엔드포인트 전용 — 일반 PUT에서는 서버 값 유지
    saveLogs: existing?.saveLogs || [],
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
    const initialPwd = pwd || '1234';
    return { ...rest, pwd: encryptPwd(initialPwd), pwdHash: hashPassword(initialPwd) };
  });
  return {
    id: school.id,
    name: school.name,
    grade: school.grade,
    type: school.type === 'lecture' ? 'lecture' : 'regular',
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
  await upsertSchoolSummary(normalized);
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
  await upsertSchoolSummary(normalized);
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

// 관리자용 응답에서는 pwdHash는 절대 내려보내지 않고, 암호화된 pwd는 이 시점에만 복호화해서 내려줌
// (DB에는 암호화된 값만 남아있고, 평문은 이 응답이 만들어지는 순간에만 메모리상에 잠깐 존재)
export function toAdminView(school) {
  if (!school) return null;
  return {
    ...school,
    students: (school.students || []).map(({ pwdHash, pwd, ...rest }) => ({ ...rest, pwd: decryptPwd(pwd) })),
    withdrawnStudents: (school.withdrawnStudents || []).map(({ pwdHash, pwd, ...rest }) => ({ ...rest, pwd: decryptPwd(pwd) })),
  };
}
