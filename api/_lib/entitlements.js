// 강좌 수강권을 "회원(member)"과 "학생(student)" 양쪽 신원이 공통으로 가질 수 있게 하는 계층.
// Codex 리뷰 권고: member 전용 로직을 student용으로 복제하지 않고, ownerType+ownerId로
// 추상화해서 결제/부여/회수 로직 자체는 하나로 유지한다. 저장 위치만 다르다
// (member는 member.entitlements, student는 학교 blob 안 student.entitlements).
import { getSchool, mutateSchool } from './school.js';
import { getMember, updateMemberEntitlements } from './member.js';

// student ownerId는 "schoolId:studentId" 합성값 — 학생 id 자체는 전역 유니크로 취급하지만
// (school.js 주석 참고), 조회 시 매번 전체 학교를 스캔하지 않도록 schoolId를 같이 들고 다닌다.
export function makeStudentOwnerId(schoolId, studentId) {
  return `${schoolId}:${studentId}`;
}
export function parseStudentOwnerId(ownerId) {
  const idx = String(ownerId).indexOf(':');
  if (idx === -1) return { schoolId: null, studentId: ownerId };
  return { schoolId: ownerId.slice(0, idx), studentId: ownerId.slice(idx + 1) };
}

export async function getOwnerEntitlements(ownerType, ownerId) {
  if (ownerType === 'member') {
    const member = await getMember(ownerId);
    return member ? (member.entitlements || []) : null;
  }
  const { schoolId, studentId } = parseStudentOwnerId(ownerId);
  const school = schoolId ? await getSchool(schoolId) : null;
  if (!school) return null;
  const student = (school.students || []).find(s => s.id === studentId);
  return student ? (student.entitlements || []) : null;
}

export async function setOwnerEntitlements(ownerType, ownerId, entitlements) {
  if (ownerType === 'member') {
    return await updateMemberEntitlements(ownerId, entitlements);
  }
  const { schoolId, studentId } = parseStudentOwnerId(ownerId);
  if (!schoolId) return null;
  const result = await mutateSchool(schoolId, (sc) => {
    const student = (sc.students || []).find(s => s.id === studentId);
    if (!student) throw new Error('학생을 찾을 수 없습니다');
    student.entitlements = entitlements;
  });
  if (!result) return null;
  return (result.school.students || []).find(s => s.id === studentId) || null;
}
