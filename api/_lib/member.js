import { getRedis } from './redis.js';

const MEMBER_PREFIX = 'member:';
const MEMBER_INDEX_KEY = 'member:index';
const PHONE_INDEX_PREFIX = 'member:phone:';

export async function getMember(id) {
  const redis = getRedis();
  return await redis.get(MEMBER_PREFIX + id);
}

export async function findMemberByPhone(phone) {
  const redis = getRedis();
  const id = await redis.get(PHONE_INDEX_PREFIX + phone);
  if (!id) return null;
  return await getMember(id);
}

async function addToMemberIndex(id) {
  const redis = getRedis();
  const index = await redis.get(MEMBER_INDEX_KEY);
  const idx = Array.isArray(index) ? index : [];
  if (!idx.includes(id)) {
    idx.push(id);
    await redis.set(MEMBER_INDEX_KEY, idx);
  }
}

export async function findOrCreateMemberByPhone(phone) {
  const redis = getRedis();
  const newId = 'mem' + Date.now() + Math.floor(Math.random() * 1000);
  const member = {
    id: newId, phone, name: '', createdAt: new Date().toISOString(),
    entitlements: [], linkedSchoolId: null, linkedStudentId: null,
  };
  // 먼저 회원 레코드를 써둔다(고유 id라 다른 요청과 충돌 없음) — 그래야 전화번호 인덱스가
  // 가리키는 회원이 항상 실제로 존재함을 보장할 수 있다(인덱스 선점을 먼저 하면, 선점 직후
  // 레코드를 쓰기 전에 실패할 경우 그 번호가 영구적으로 로그인 불가능해짐).
  await redis.set(MEMBER_PREFIX + newId, member);
  const claimed = await redis.set(PHONE_INDEX_PREFIX + phone, newId, { nx: true });

  if (!claimed) {
    // 이미 다른 요청이 먼저 선점 — 방금 만든 레코드는 버리고(참조하는 곳이 없어 안전) 기존 회원을 사용
    await redis.del(MEMBER_PREFIX + newId);
    let existing = await findMemberByPhone(phone);
    if (!existing) {
      // 선점한 쪽이 인덱스만 쓰고 아직 자기 member 레코드를 다 쓰기 전인 극히 짧은 순간일 수 있음 — 한 번 더 시도
      await new Promise(r => setTimeout(r, 50));
      existing = await findMemberByPhone(phone);
    }
    if (!existing) throw new Error('회원 조회 중 오류가 발생했습니다. 다시 시도해주세요');
    return { member: existing, isNew: false };
  }

  await addToMemberIndex(newId);
  return { member, isNew: true };
}

export async function updateMemberName(id, name) {
  const redis = getRedis();
  const member = await getMember(id);
  if (!member) return null;
  member.name = name;
  await redis.set(MEMBER_PREFIX + id, member);
  return member;
}
