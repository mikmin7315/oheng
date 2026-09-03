import { getRedis } from './redis.js';
import { getSchoolSummaries } from './school.js';

const ROUNDS_KEY = 'mock:rounds';
const subKey = (roundId) => `mock:sub:${roundId}`;
const aggKey = (roundId) => `mock:agg:${roundId}`;

// 응시자가 이보다 적으면 학생에게 등수·평균·최고점·등급분포를 숨긴다.
// 소수일 때는 평균과 내 점수만으로 남의 점수를 역산할 수 있다.
export const MIN_VISIBLE_COUNT = 5;

export class MockError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// @upstash/redis가 JSON처럼 보이는 문자열을 알아서 객체로 되돌려주는 경우가 있어
// (school.js의 school:summary 해시에서 이미 겪은 문제) 문자열일 때만 직접 파싱한다.
function parseVal(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}

// school.grade는 자유 텍스트라 '1학년' / '고1' / ' 1 학년 '이 섞일 수 있다.
// 섞이면 등수가 두 덩어리로 쪼개져 1등이 두 명 나오는데 화면상 알아채기 어렵다.
// 회차와 반을 잇는 유일한 키이므로 비교·저장 전에 항상 이 함수를 통과시킨다.
export function normalizeGrade(raw) {
  const s = String(raw ?? '').replace(/\s+/g, '');
  if (!s) return '';
  const hs = /^고([1-3])$/.exec(s);
  if (hs) return `${hs[1]}학년`;
  const bare = /^([1-6])$/.exec(s);
  if (bare) return `${bare[1]}학년`;
  return s;
}

export function parseScore(raw, maxScore) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > maxScore) return null;
  return n;
}

// 등급은 "안 냄"(null)과 "잘못된 값"을 구분해야 해서 { ok, value } 형태로 돌려준다.
export function parseGradeLevel(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 9) return { ok: false, value: null };
  return { ok: true, value: n };
}

export function isRoundOpen(round, now = Date.now()) {
  if (!round) return false;
  return now >= round.openAt && now < round.closeAt;
}

// 순수 함수 — Redis 없이 단독으로 테스트한다.
export function computeAggregate(subs) {
  const empty = {
    count: 0, avg: null, max: null, min: null,
    rankOf: {}, rankCounts: {}, gradeDist: {}, bySchool: {}, computedAt: Date.now(),
  };
  const valid = (subs || []).filter(s => s && !s.excluded && Number.isFinite(s.score));
  if (!valid.length) return empty;

  // 표준 경쟁 등수: 동점은 같은 등수, 다음은 건너뛴다 (88·88·85 → 1·1·3).
  // 기존 성적표의 totalRank/rankCounts와 같은 규칙.
  const sorted = [...valid].sort((a, b) => b.score - a.score);
  const rankOf = {};
  const rankCounts = {};
  let rank = 0;
  sorted.forEach((s, i) => {
    if (i === 0 || s.score !== sorted[i - 1].score) rank = i + 1;
    rankOf[s.sid] = rank;
    rankCounts[rank] = (rankCounts[rank] || 0) + 1;
  });

  const scores = valid.map(s => s.score);
  const gradeDist = {};
  valid.forEach(s => {
    const g = s.grade;
    if (Number.isInteger(g) && g >= 1 && g <= 9) gradeDist[g] = (gradeDist[g] || 0) + 1;
  });

  const bySchool = {};
  valid.forEach(s => {
    const key = s.schoolId || '(미상)';
    if (!bySchool[key]) bySchool[key] = { schoolName: s.schoolName || '', count: 0, sum: 0, max: s.score };
    const b = bySchool[key];
    b.count += 1; b.sum += s.score; b.max = Math.max(b.max, s.score);
  });
  Object.values(bySchool).forEach(b => {
    b.avg = Math.round((b.sum / b.count) * 10) / 10;
    delete b.sum;
  });

  return {
    count: valid.length,
    avg: Math.round((scores.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10,
    max: Math.max(...scores),
    min: Math.min(...scores),
    rankOf, rankCounts, gradeDist, bySchool,
    computedAt: Date.now(),
  };
}

// 학생에게 내려보낼 형태로 깎는다. 다른 학생의 이름·점수는 어떤 경우에도 들어가지 않는다.
export function studentViewOf(round, sub, agg, now = Date.now()) {
  const closed = now >= round.closeAt;
  const reveal = closed && (agg.count || 0) >= MIN_VISIBLE_COUNT;
  const rank = reveal ? (agg.rankOf?.[sub.sid] ?? null) : null;
  return {
    roundId: round.id,
    title: round.title,
    examDate: round.examDate,
    grade: round.grade,
    maxScore: round.maxScore,
    score: sub.score,
    myGrade: sub.grade ?? null,
    excluded: !!sub.excluded,
    rank,
    tieCount: rank != null ? (agg.rankCounts?.[rank] || 0) : null,
    count: agg.count || 0,
    avg: reveal ? agg.avg : null,
    max: reveal ? agg.max : null,
    gradeDist: reveal ? (agg.gradeDist || {}) : null,
  };
}

export async function listRounds() {
  const map = await getRedis().hgetall(ROUNDS_KEY);
  if (!map) return [];
  return Object.values(map).map(parseVal).filter(Boolean)
    .sort((a, b) => String(b.examDate || '').localeCompare(String(a.examDate || '')));
}

export async function getRound(id) {
  if (!id) return null;
  return parseVal(await getRedis().hget(ROUNDS_KEY, String(id)));
}

export async function saveRound(input, actorId) {
  const grade = normalizeGrade(input?.grade);
  if (!grade) throw new MockError(400, '학년을 선택하세요');
  const title = String(input?.title || '').trim();
  if (!title) throw new MockError(400, '회차 제목을 입력하세요');
  const examDate = String(input?.examDate || '').trim();
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(examDate)) throw new MockError(400, '응시일은 YYYY.MM.DD 형식으로 입력하세요');
  const openAt = Number(input?.openAt);
  const closeAt = Number(input?.closeAt);
  if (!Number.isFinite(openAt) || !Number.isFinite(closeAt) || closeAt <= openAt) {
    throw new MockError(400, '입력 마감일은 입력 시작일보다 뒤여야 합니다');
  }
  const maxScore = Number(input?.maxScore ?? 100);
  if (!Number.isInteger(maxScore) || maxScore < 1 || maxScore > 200) {
    throw new MockError(400, '만점은 1~200 사이 정수여야 합니다');
  }

  const existing = input?.id ? await getRound(input.id) : null;
  const round = {
    // Date.now()만 쓰면 같은 밀리초에 만든 두 회차가 같은 id를 갖는다(뒤엣것이 앞엣것을
    // 덮어씀). 뒤에 짧은 무작위 문자를 붙여 충돌을 막는다.
    id: existing?.id || ('mr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    grade, title, examDate, openAt, closeAt, maxScore,
    createdBy: existing?.createdBy || actorId || '',
    createdAt: existing?.createdAt || Date.now(),
    archived: !!input?.archived,
  };
  await getRedis().hset(ROUNDS_KEY, { [round.id]: JSON.stringify(round) });
  return round;
}

export async function deleteRound(id) {
  const redis = getRedis();
  await redis.hdel(ROUNDS_KEY, String(id));
  await redis.del(subKey(id));
  await redis.del(aggKey(id));
}

export async function getSubmissions(roundId) {
  const map = await getRedis().hgetall(subKey(roundId));
  if (!map) return [];
  return Object.values(map).map(parseVal).filter(Boolean);
}

export async function getSubmission(roundId, sid) {
  if (!sid) return null;
  return parseVal(await getRedis().hget(subKey(roundId), String(sid)));
}

export async function countSubmissions(roundId) {
  return (await getRedis().hlen(subKey(roundId))) || 0;
}

// 필드 1개 쓰기라 학생끼리도, 선생님의 성적 일괄저장과도 경쟁하지 않는다.
// 무거운 school blob의 CAS 재시도 루프를 타지 않는 게 이 구조를 고른 이유.
export async function putSubmission(roundId, sub) {
  await getRedis().hset(subKey(roundId), { [sub.sid]: JSON.stringify(sub) });
  return recomputeAggregate(roundId);
}

export async function removeSubmission(roundId, sid) {
  await getRedis().hdel(subKey(roundId), String(sid));
  return recomputeAggregate(roundId);
}

export async function recomputeAggregate(roundId) {
  const agg = computeAggregate(await getSubmissions(roundId));
  await getRedis().set(aggKey(roundId), agg);
  return agg;
}

// 캐시가 없거나 형태가 깨져 있으면 그 자리에서 다시 계산해 저장한다
// (school:summary의 self-healing과 같은 방식).
export async function getAggregate(roundId) {
  const cached = parseVal(await getRedis().get(aggKey(roundId)));
  if (cached && typeof cached.count === 'number' && cached.rankOf) return cached;
  return recomputeAggregate(roundId);
}

// 그 학년 반들의 studentCount 합. school:summary 해시만 읽으므로 학교 blob은 건드리지 않는다.
export async function countStudentsInGrade(grade) {
  const g = normalizeGrade(grade);
  if (!g) return 0;
  const summaries = await getSchoolSummaries();
  return summaries
    .filter(s => normalizeGrade(s.grade) === g)
    .reduce((n, s) => n + (s.studentCount || 0), 0);
}
