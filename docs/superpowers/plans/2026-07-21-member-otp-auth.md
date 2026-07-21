# 회원 휴대폰 OTP 인증 (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** oheng.co.kr에 방문한 일반인이 휴대폰 번호 + SMS 인증번호만으로 가입/로그인할 수 있는 회원 시스템을 만든다. (강좌/결제/lecture.html UI 연결은 이 계획 이후 별도 계획서에서 다룬다 — 이 계획은 백엔드 API가 curl로 완결 동작하는 것까지가 목표다.)

**Architecture:** 기존 `api/_lib/auth.js`의 세션 인프라(`createSession`/`getSession`/쿠키)를 그대로 재사용하고 `role:'member'`를 새로 추가한다. OTP 코드는 Redis에 TTL로 저장하고, 회원 레코드는 기존 `school.js`와 같은 패턴(`member:index` + `member:{id}`)으로 저장한다. 신규 가입 시 전화번호 인덱스를 `SET NX`로 원자적으로 선점해 동시 요청으로 인한 중복 가입을 막는다. SMS는 기존 솔라피 계정으로 일반 SMS(알림톡 아님)를 보낸다.

**Tech Stack:** Node.js(Vercel Serverless Functions), Upstash Redis(`@upstash/redis`), solapi(이미 설치돼 있는 패키지, 새 의존성 추가 없음).

## Global Constraints

- 이 프로젝트는 **자동화 테스트 프레임워크가 없다** (package.json에 jest/mocha 등 없음, `docs/superpowers/specs/2026-07-21-member-course-payments-design.md` 참고). 이 계획의 "테스트" 단계는 `node --check`로 문법 검증 + 배포 후 curl로 실제 엔드포인트를 호출해 응답을 확인하는 방식이다 — 이 프로젝트에서 지금까지 실제로 써온 검증 방식을 그대로 따른다.
- Vercel Hobby 플랜은 서버리스 함수 12개 제한이 있다. 지금 8개(`api/admin/[action].js`, `api/admin/school/[id].js`, `api/auth/[action].js`, `api/push.js`, `api/send.js`, `api/student/[action].js`, `api/subscribe.js`, `api/videos/[action].js`) 사용 중이므로, 새 라우트는 반드시 동적 라우트 파일 하나(`api/member-auth/[action].js`)로 액션들을 통합한다 — 액션마다 새 파일을 만들지 않는다.
- 세션/쿠키/CSRF(`isSameOrigin`) 패턴은 기존 `api/auth/[action].js`, `api/student/[action].js`와 완전히 동일하게 따른다 (새로운 인증 방식을 발명하지 않는다).
- 검증은 실제 배포된 `https://oheng.co.kr`에 대해 진행하고(이 프로젝트에 별도 스테이징 환경이 없음, 지금까지도 항상 이렇게 검증해왔다), 실제 SMS 발송 비용이 발생하므로 검증에는 작업자 본인의 실제 휴대폰 번호를 쓴다. 테스트로 만든 회원 데이터는 마지막 단계에서 정리한다.

---

### Task 1: 회원 세션 헬퍼 추가

**Files:**
- Modify: `api/_lib/auth.js` (기존 `requireStudentSession` 함수 바로 아래에 추가)

**Interfaces:**
- Consumes: 이 파일에 이미 있는 `getSessionToken(req)`, `getSession(token)` (수정 없음)
- Produces: `requireMemberSession(req)` — 유효한 회원 세션이면 `{role:'member', memberId, createdAt}` 반환, 아니면 `null`. Task 5에서 사용.

- [ ] **Step 1: `requireMemberSession` 추가**

`api/_lib/auth.js`에서 아래 블록을 찾는다:

```js
// 요청 쿠키의 세션이 유효한 학생 세션인지 확인 — 아니면 null
export async function requireStudentSession(req) {
  const token = getSessionToken(req);
  const session = await getSession(token);
  if (!session || session.role !== 'student' || !session.studentId || !session.schoolId) return null;
  return session;
}
```

바로 아래에 다음을 추가한다:

```js
// 요청 쿠키의 세션이 유효한 일반 회원(휴대폰 인증) 세션인지 확인 — 아니면 null
export async function requireMemberSession(req) {
  const token = getSessionToken(req);
  const session = await getSession(token);
  if (!session || session.role !== 'member' || !session.memberId) return null;
  return session;
}
```

- [ ] **Step 2: 문법 검증**

Run: `cd C:/Users/mikmi/oheng && node --check api/_lib/auth.js`
Expected: 아무 출력 없이 종료 (에러 없음)

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add api/_lib/auth.js
git commit -m "회원(휴대폰 인증) 세션 헬퍼 requireMemberSession 추가"
```

---

### Task 2: OTP 저장/검증 헬퍼

**Files:**
- Create: `api/_lib/otp.js`

**Interfaces:**
- Consumes: `api/_lib/redis.js`의 `getRedis()` (기존)
- Produces:
  - `generateOtpCode(): string` — 6자리 숫자 문자열
  - `storeOtp(phone: string, code: string): Promise<void>`
  - `verifyOtp(phone: string, code: string): Promise<{ok: true} | {ok: false, reason: 'expired'|'mismatch'|'too_many_attempts'}>`
  이 세 함수를 Task 5의 `api/member-auth/[action].js`에서 사용한다.

- [ ] **Step 1: `api/_lib/otp.js` 작성**

```js
import crypto from 'crypto';
import { getRedis } from './redis.js';

const OTP_PREFIX = 'otp:';
const OTP_TTL_SEC = 180;
const MAX_ATTEMPTS = 5;

export function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export async function storeOtp(phone, code) {
  const redis = getRedis();
  await redis.set(OTP_PREFIX + phone, { code, attempts: 0 }, { ex: OTP_TTL_SEC });
}

// 성공 시 { ok: true }, 실패 시 사유와 함께 { ok: false, reason }.
// 5회 틀리면 코드 자체를 지워서 재요청(otp-request)을 다시 받도록 강제한다.
export async function verifyOtp(phone, code) {
  const redis = getRedis();
  const key = OTP_PREFIX + phone;
  const stored = await redis.get(key);
  if (!stored) return { ok: false, reason: 'expired' };
  if (stored.attempts >= MAX_ATTEMPTS) {
    await redis.del(key);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (String(stored.code) !== String(code)) {
    stored.attempts += 1;
    await redis.set(key, stored, { ex: OTP_TTL_SEC });
    return { ok: false, reason: 'mismatch' };
  }
  await redis.del(key);
  return { ok: true };
}
```

- [ ] **Step 2: 문법 검증**

Run: `cd C:/Users/mikmi/oheng && node --check api/_lib/otp.js`
Expected: 아무 출력 없이 종료

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add api/_lib/otp.js
git commit -m "OTP 코드 저장/검증 헬퍼(api/_lib/otp.js) 추가"
```

---

### Task 3: 일반 SMS 발송 헬퍼

**Files:**
- Create: `api/_lib/sms.js`

**Interfaces:**
- Consumes: 환경변수 `SOLAPI_API_KEY`, `SOLAPI_API_SECRET`, `SOLAPI_SENDER` (기존 `api/send.js`와 동일하게 이미 Vercel에 설정돼 있음)
- Produces: `sendPlainSms(to: string, text: string): Promise<unknown>` — Task 5에서 사용. 카카오 알림톡 템플릿을 쓰는 기존 `api/send.js`(`kakaoOptions` 사용)와 달리, `text`만 넘겨서 일반 SMS/LMS로 즉시 발송(사전 템플릿 승인 불필요).

- [ ] **Step 1: `api/_lib/sms.js` 작성**

```js
const { SolapiMessageService } = require('solapi');

const messageService = new SolapiMessageService(
  process.env.SOLAPI_API_KEY,
  process.env.SOLAPI_API_SECRET
);

const SENDER = process.env.SOLAPI_SENDER || '01090080851';

// 알림톡 템플릿(api/send.js)과 달리 kakaoOptions 없이 호출하면 일반 SMS/LMS로 즉시 발송된다
// (솔라피가 텍스트 길이 보고 SMS/LMS 자동 판단, 사전 템플릿 승인 불필요).
export async function sendPlainSms(to, text) {
  const phone = String(to).replace(/[^0-9]/g, '');
  return messageService.send({ to: phone, from: SENDER, text });
}
```

- [ ] **Step 2: 문법 검증**

Run: `cd C:/Users/mikmi/oheng && node --check api/_lib/sms.js`
Expected: 아무 출력 없이 종료

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add api/_lib/sms.js
git commit -m "일반 SMS 발송 헬퍼(api/_lib/sms.js) 추가 — OTP 발송용"
```

---

### Task 4: 회원 데이터 헬퍼 (원자적 가입 포함)

**Files:**
- Create: `api/_lib/member.js`

**Interfaces:**
- Consumes: `api/_lib/redis.js`의 `getRedis()`
- Produces:
  - `getMember(id: string): Promise<Member|null>`
  - `findMemberByPhone(phone: string): Promise<Member|null>`
  - `findOrCreateMemberByPhone(phone: string): Promise<{member: Member, isNew: boolean}>`
  - `updateMemberName(id: string, name: string): Promise<Member|null>`
  - `Member` 형태: `{ id, phone, name, createdAt, entitlements: [], linkedSchoolId: null, linkedStudentId: null }`
  Task 5에서 이 네 함수를 사용한다.

- [ ] **Step 1: `api/_lib/member.js` 작성**

```js
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
```

- [ ] **Step 2: 문법 검증**

Run: `cd C:/Users/mikmi/oheng && node --check api/_lib/member.js`
Expected: 아무 출력 없이 종료

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add api/_lib/member.js
git commit -m "회원 데이터 헬퍼(api/_lib/member.js) 추가 — 전화번호 원자적 선점으로 중복가입 방지"
```

---

### Task 5: `api/member-auth/[action].js` 라우트

**Files:**
- Create: `api/member-auth/[action].js`

**Interfaces:**
- Consumes:
  - `api/_lib/auth.js`: `createSession`, `setSessionCookie`, `checkRateLimit`, `isSameOrigin`, `getClientIp`, `getSessionToken`, `getSession`, `deleteSession`, `clearSessionCookie`, `requireMemberSession` (Task 1에서 추가)
  - `api/_lib/otp.js`: `generateOtpCode`, `storeOtp`, `verifyOtp` (Task 2)
  - `api/_lib/member.js`: `findOrCreateMemberByPhone`, `updateMemberName`, `getMember` (Task 4)
  - `api/_lib/sms.js`: `sendPlainSms` (Task 3)
- Produces: 아래 5개 엔드포인트. Phase 2(강좌)·Phase 3(결제)에서 `requireMemberSession`을 그대로 재사용해 인증한다.
  - `POST /api/member-auth/otp-request { phone }` → `{ success: true }`
  - `POST /api/member-auth/otp-verify { phone, code }` → `{ success: true, isNew: boolean, name: string }` (쿠키로 세션 발급)
  - `POST /api/member-auth/profile { name }` (세션 필요) → `{ success: true }`
  - `GET /api/member-auth/me` (세션 필요) → `{ success: true, member: { id, phone, name } }`
  - `POST /api/member-auth/logout` → `{ success: true }`

- [ ] **Step 1: `api/member-auth/[action].js` 작성**

```js
import {
  createSession, setSessionCookie, checkRateLimit, isSameOrigin, getClientIp,
  getSessionToken, getSession, deleteSession, clearSessionCookie, requireMemberSession,
} from '../_lib/auth.js';
import { generateOtpCode, storeOtp, verifyOtp } from '../_lib/otp.js';
import { findOrCreateMemberByPhone, updateMemberName, getMember } from '../_lib/member.js';
import { sendPlainSms } from '../_lib/sms.js';

function normalizePhone(raw) {
  return String(raw || '').replace(/[^0-9]/g, '');
}

export default async function handler(req, res) {
  const { action } = req.query;

  if (action === 'otp-request') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const phone = normalizePhone(req.body?.phone);
    if (phone.length < 10) return res.status(400).json({ success: false, message: '휴대폰 번호를 확인해주세요' });

    const phoneOk = await checkRateLimit('otp-req-phone', phone, 5, 3600);
    const ipOk = await checkRateLimit('otp-req-ip', getClientIp(req), 10, 3600);
    if (!phoneOk || !ipOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const code = generateOtpCode();
    await storeOtp(phone, code);
    try {
      await sendPlainSms(phone, `[OHENG] 인증번호는 ${code} 입니다. 3분 내에 입력해주세요.`);
    } catch (e) {
      return res.status(500).json({ success: false, message: '인증번호 발송에 실패했습니다' });
    }
    return res.status(200).json({ success: true });
  }

  if (action === 'otp-verify') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '').trim();
    if (!phone || !code) return res.status(400).json({ success: false, message: '휴대폰 번호와 인증번호를 입력하세요' });

    const result = await verifyOtp(phone, code);
    if (!result.ok) {
      const msg = result.reason === 'too_many_attempts' ? '인증 시도 횟수를 초과했습니다. 인증번호를 다시 받아주세요'
        : result.reason === 'expired' ? '인증번호가 만료되었습니다. 다시 받아주세요'
        : '인증번호가 일치하지 않습니다';
      return res.status(400).json({ success: false, message: msg });
    }

    const { member, isNew } = await findOrCreateMemberByPhone(phone);
    const { token, maxAge } = await createSession({ role: 'member', memberId: member.id });
    setSessionCookie(res, token, maxAge);
    return res.status(200).json({ success: true, isNew, name: member.name || '' });
  }

  if (action === 'profile') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const session = await requireMemberSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: '이름을 입력하세요' });
    await updateMemberName(session.memberId, name);
    return res.status(200).json({ success: true });
  }

  if (action === 'me') {
    if (req.method !== 'GET') return res.status(405).end();
    const session = await requireMemberSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const member = await getMember(session.memberId);
    if (!member) return res.status(404).json({ success: false, message: '회원 정보를 찾을 수 없습니다' });
    return res.status(200).json({ success: true, member: { id: member.id, phone: member.phone, name: member.name } });
  }

  if (action === 'logout') {
    if (req.method !== 'POST') return res.status(405).end();
    const token = getSessionToken(req);
    await deleteSession(token);
    clearSessionCookie(res);
    return res.status(200).json({ success: true });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
```

- [ ] **Step 2: 문법 검증**

Run: `cd C:/Users/mikmi/oheng && node --check "api/member-auth/[action].js"`
Expected: 아무 출력 없이 종료

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add "api/member-auth/[action].js"
git commit -m "회원 휴대폰 OTP 인증 라우트(api/member-auth/[action].js) 추가"
```

- [ ] **Step 4: Push (배포 트리거)**

```bash
git push
```

Run: `until curl -s -o /dev/null -w "%{http_code}" https://oheng.co.kr/api/member-auth/me | grep -qE '^401$'; do sleep 5; done; echo DEPLOYED`
Expected: 배포 완료 후 `DEPLOYED` 출력 (로그인 안 한 상태로 `/me` 호출하면 401이 정상)

---

### Task 6: 실제 종단 검증 (본인 번호로 실제 OTP 로그인) + 정리

**Files:** 없음 (curl 검증만)

**Interfaces:** 없음 (이 계획의 마지막 검증 단계)

- [ ] **Step 1: 인증번호 요청**

Run (YOUR_PHONE을 본인 실제 휴대폰 번호로 교체, 하이픈 없이):

```bash
curl -s -X POST https://oheng.co.kr/api/member-auth/otp-request \
  -H "Content-Type: application/json" \
  -d '{"phone":"YOUR_PHONE"}'
```

Expected: `{"success":true}` 및 본인 휴대폰에 6자리 인증번호 SMS 수신

- [ ] **Step 2: 받은 인증번호로 로그인 (쿠키 저장하며 호출)**

Run (RECEIVED_CODE를 문자로 받은 6자리 코드로 교체):

```bash
curl -s -c /tmp/oheng_member_cookie.txt -X POST https://oheng.co.kr/api/member-auth/otp-verify \
  -H "Content-Type: application/json" \
  -d '{"phone":"YOUR_PHONE","code":"RECEIVED_CODE"}'
```

Expected: `{"success":true,"isNew":true,"name":""}` (신규 번호인 경우)

- [ ] **Step 3: 로그인 세션 확인**

Run:

```bash
curl -s -b /tmp/oheng_member_cookie.txt https://oheng.co.kr/api/member-auth/me
```

Expected: `{"success":true,"member":{"id":"mem...","phone":"YOUR_PHONE","name":""}}`

- [ ] **Step 4: 이름 등록**

Run:

```bash
curl -s -b /tmp/oheng_member_cookie.txt -X POST https://oheng.co.kr/api/member-auth/profile \
  -H "Content-Type: application/json" \
  -d '{"name":"테스트"}'
curl -s -b /tmp/oheng_member_cookie.txt https://oheng.co.kr/api/member-auth/me
```

Expected: 두 번째 호출 응답에 `"name":"테스트"` 반영됨

- [ ] **Step 5: 틀린 인증번호 / 만료 처리 확인**

Run:

```bash
curl -s -X POST https://oheng.co.kr/api/member-auth/otp-verify \
  -H "Content-Type: application/json" \
  -d '{"phone":"YOUR_PHONE","code":"000000"}'
```

Expected: `{"success":false,"message":"인증번호가 만료되었습니다. 다시 받아주세요"}` (Step 2에서 이미 검증 성공해 코드가 삭제된 상태이므로 `expired` 처리됨 — 정상)

- [ ] **Step 6: 로그아웃 확인**

Run:

```bash
curl -s -b /tmp/oheng_member_cookie.txt -X POST https://oheng.co.kr/api/member-auth/logout
curl -s -b /tmp/oheng_member_cookie.txt https://oheng.co.kr/api/member-auth/me
```

Expected: logout은 `{"success":true}`, 그 다음 `/me` 호출은 `{"success":false,"message":"Unauthorized"}`

- [ ] **Step 7: 테스트 회원 데이터 정리**

이 단계는 관리자 전용 정리용 엔드포인트가 아직 없으므로(Phase 1 범위 밖), Upstash 콘솔에서 `member:mem...`, `member:phone:YOUR_PHONE` 키를 직접 삭제하거나, 실서비스 오픈 전까지는 테스트 계정으로 남겨둬도 무방함을 확인하고 넘어간다.

- [ ] **Step 8: 최종 커밋 로그 확인**

Run: `cd C:/Users/mikmi/oheng && git log --oneline -6`
Expected: Task 1~5의 커밋 5개가 순서대로 보임
