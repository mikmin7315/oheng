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

// 같은 번호로 동시에 인증 요청이 들어와도 회원이 중복 생성되지 않도록,
// 전화번호 인덱스를 SET NX로 먼저 원자적으로 선점한다.
// 선점에 실패하면(이미 다른 요청이 먼저 선점) 그 회원을 조회해서 반환한다.
export async function findOrCreateMemberByPhone(phone) {
  const redis = getRedis();
  const newId = 'mem' + Date.now() + Math.floor(Math.random() * 1000);
  const claimed = await redis.set(PHONE_INDEX_PREFIX + phone, newId, { nx: true });

  if (!claimed) {
    let existing = await findMemberByPhone(phone);
    if (!existing) {
      // 선점한 쪽이 인덱스만 쓰고 아직 member 레코드를 쓰기 전인 극히 짧은 순간일 수 있음 — 한 번 더 시도
      await new Promise(r => setTimeout(r, 50));
      existing = await findMemberByPhone(phone);
    }
    if (!existing) throw new Error('회원 조회 중 오류가 발생했습니다. 다시 시도해주세요');
    return { member: existing, isNew: false };
  }

  const member = {
    id: newId, phone, name: '', createdAt: new Date().toISOString(),
    entitlements: [], linkedSchoolId: null, linkedStudentId: null,
  };
  await redis.set(MEMBER_PREFIX + newId, member);
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
