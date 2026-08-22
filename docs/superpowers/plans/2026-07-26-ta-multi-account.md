# 조교 다중 계정 시스템 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `admin:auth`를 계정 하나짜리 구조에서 여러 조교 계정을 지원하는 구조로 바꾸고, 원장님(마스터) 계정만 조교 계정을 추가·삭제·비번초기화할 수 있는 관리 화면을 만든다.

**Architecture:** Redis `admin:auth` 값을 `{version, accounts:[{id,name,pwdHash,isMaster,...}]}` 형태로 전환(기존 단일 객체는 자동 마이그레이션). 세션에 `actorId`/`actorName`/`isMaster`를 실어 로그인 주체를 식별하고, 마스터 전용 API는 세션 값만 믿지 않고 Redis 최신 상태로 재검증한다. 새 서버리스 함수는 만들지 않고 기존 `api/auth/[action].js`, `api/admin/[action].js`에 로직을 추가한다.

**Tech Stack:** Vercel serverless functions (Node, ESM), Upstash Redis(`@upstash/redis`), Node 내장 `crypto`(scrypt), 순수 HTML/CSS/JS 단일 페이지(index.html), 테스트 프레임워크 없음 — 이 프로젝트의 기존 검증 방식(로컬 `node -e`로 순수 로직 확인, 배포 후 `curl`로 실제 API 확인)을 그대로 따른다.

## Global Constraints

- 새 서버리스 함수 파일을 만들지 않는다 (Vercel Hobby 12개 제한 대응 — 기존 `api/auth/[action].js`, `api/admin/[action].js`에 액션 추가).
- 모든 POST 액션은 `isSameOrigin(req)` 체크를 유지한다.
- `pwdHash`는 어떤 API 응답에도 포함하지 않는다.
- id는 저장/비교 항상 `String(id).trim().toLowerCase()`로 정규화한다.
- 마스터 전용 액션은 세션의 `isMaster` 값만 믿지 않고 Redis 최신 계정 목록으로 재검증한다.
- 스펙 문서: `docs/superpowers/specs/2026-07-26-ta-multi-account-design.md` (이 계획은 그 문서의 승인된 설계를 그대로 구현한다 — 상충되면 스펙이 우선).

---

### Task 1: `api/_lib/auth.js`에 다중 계정 헬퍼 추가

**Files:**
- Modify: `api/_lib/auth.js` (기존 172줄, `checkLoginRateLimit` 함수 뒤·`requireAdminSession` 앞에 신규 블록 삽입, `requireAdminSessionOrApiToken` 함수 뒤에 마스터 전용 헬퍼 2개 추가)

**Interfaces:**
- Produces: `normalizeAdminAccounts(raw) -> {version:number, accounts:Array}`, `getAdminAccounts() -> Promise<{version, accounts}>`, `setAdminAccounts(accounts, expectedVersion) -> Promise<{version, accounts}>` (버전 불일치 시 `err.code==='VERSION_CONFLICT'`인 Error를 throw), `findAdminAccount(accounts, id) -> account|null`, `requireMasterAdminSession(req) -> Promise<session|null>`, `requireMasterAdminSessionOrApiToken(req) -> Promise<session|null>`. Account shape: `{id, name, pwdHash, isMaster, createdAt, updatedAt, passwordChangedAt}`.

- [ ] **Step 1: `checkLoginRateLimit` 함수 뒤(140번째 줄, `requireAdminSession` 정의 바로 앞)에 계정 헬퍼 블록 삽입**

`api/_lib/auth.js`에서 아래 텍스트를 찾는다:
```js
export async function checkLoginRateLimit(key) {
  return checkRateLimit('login', key, 10, 60); // 1분에 10회 초과 시 차단
}

// 요청 쿠키의 세션이 유효한 관리자 세션인지 확인 — 아니면 null
export async function requireAdminSession(req) {
```
그 사이에 아래 블록을 삽입한다(즉 `checkLoginRateLimit` 함수 닫는 `}` 다음 줄부터):

```js

// ── 관리자 계정 목록 (다중 계정, v2) ──
// admin:auth는 원래 단일 객체({id,pwdHash})였다가 다중 계정 지원을 위해
// {version, accounts:[{id,name,pwdHash,isMaster,...}]} 구조로 바뀌었다.
// 이 함수들이 v1/v2 차이를 흡수해서, 호출부는 항상 v2 모양만 다루면 된다.
export function normalizeAdminAccounts(raw) {
  if (!raw) return { version: 0, accounts: [] };
  if (Array.isArray(raw.accounts)) {
    return { version: raw.version || 0, accounts: raw.accounts };
  }
  if (raw.id && raw.pwdHash) {
    // v1: 단일 계정 객체 — 마스터 계정 하나로 승격
    const now = new Date().toISOString();
    return {
      version: 0,
      accounts: [{
        id: raw.id, name: raw.name || '원장님', pwdHash: raw.pwdHash, isMaster: true,
        createdAt: raw.createdAt || now, updatedAt: raw.updatedAt || now, passwordChangedAt: raw.passwordChangedAt || now,
      }],
    };
  }
  return { version: 0, accounts: [] };
}

export async function getAdminAccounts() {
  const redis = getRedis();
  const raw = await redis.get('admin:auth');
  return normalizeAdminAccounts(raw);
}

// 쓰기 직전 현재 버전을 다시 읽어 expectedVersion과 비교 — 다르면 예외를 던져 호출부가
// 실패 처리하게 한다. 조교 계정 관리는 빈도가 낮아 낙관적 락 하나로 충분(별도 Redis
// hash/트랜잭션 도입은 하지 않음 — YAGNI).
export async function setAdminAccounts(accounts, expectedVersion) {
  const redis = getRedis();
  const current = normalizeAdminAccounts(await redis.get('admin:auth'));
  if (current.version !== expectedVersion) {
    const err = new Error('admin accounts version conflict');
    err.code = 'VERSION_CONFLICT';
    throw err;
  }
  const next = { version: expectedVersion + 1, accounts };
  await redis.set('admin:auth', next);
  return next;
}

export function findAdminAccount(accounts, id) {
  const norm = String(id || '').trim().toLowerCase();
  return accounts.find(a => a.id === norm) || null;
}
```

- [ ] **Step 2: `requireAdminSessionOrApiToken` 함수 뒤(`getClientIp` 앞)에 마스터 전용 헬퍼 추가**

`api/_lib/auth.js`에서 아래 텍스트를 찾는다:
```js
export async function requireAdminSessionOrApiToken(req) {
  const session = await requireAdminSession(req);
  if (session) return session;
  if (process.env.API_AUTH_TOKEN && req.headers['x-api-token'] === process.env.API_AUTH_TOKEN) {
    return { role: 'admin', viaApiToken: true };
  }
  return null;
}

export function getClientIp(req) {
```
그 사이에 삽입한다:

```js

// 마스터 전용 액션에서 사용 — 세션에 박제된 isMaster 값만 믿지 않고, Redis의 현재 계정
// 목록에서 실제로 그 계정이 존재하고 아직 isMaster인지 다시 확인한다(계정 삭제/권한
// 변경 이후에도 오래된 세션이 유효할 수 있으므로).
export async function requireMasterAdminSession(req) {
  const session = await requireAdminSession(req);
  if (!session || session.isMaster !== true || !session.actorId) return null;
  const { accounts } = await getAdminAccounts();
  const account = findAdminAccount(accounts, session.actorId);
  if (!account || account.isMaster !== true) return null;
  return session;
}

// API_AUTH_TOKEN 보유자는 이미 credentials/migrate 등 다른 모든 관리자 액션을 무제한으로
// 쓸 수 있으므로, 조교 계정 관리도 동일하게 마스터 권한과 동등하게 취급한다.
export async function requireMasterAdminSessionOrApiToken(req) {
  if (process.env.API_AUTH_TOKEN && req.headers['x-api-token'] === process.env.API_AUTH_TOKEN) {
    return { role: 'admin', viaApiToken: true, isMaster: true };
  }
  return requireMasterAdminSession(req);
}
```

- [ ] **Step 3: 순수 로직(Redis 불필요) 부분만 로컬에서 검증**

Redis 없이 검증 가능한 건 `normalizeAdminAccounts`와 `findAdminAccount` 뿐이다(나머지는 `getRedis()`를 호출하므로 배포 후 curl로 검증 — Task 8).

Run:
```bash
node -e "
import('./api/_lib/auth.js').then(({normalizeAdminAccounts, findAdminAccount}) => {
  const v1 = normalizeAdminAccounts({ id: 'admin', pwdHash: 'scrypt:aa:bb' });
  if (v1.accounts.length !== 1 || v1.accounts[0].isMaster !== true) throw new Error('v1 migrate failed: ' + JSON.stringify(v1));
  const v2 = normalizeAdminAccounts({ version: 3, accounts: [{id:'ta1', isMaster:false}] });
  if (v2.version !== 3 || v2.accounts.length !== 1) throw new Error('v2 passthrough failed: ' + JSON.stringify(v2));
  const found = findAdminAccount(v2.accounts, '  TA1  ');
  if (!found || found.id !== 'ta1') throw new Error('findAdminAccount normalize failed: ' + JSON.stringify(found));
  const empty = normalizeAdminAccounts(null);
  if (empty.accounts.length !== 0) throw new Error('null input should give empty accounts');
  console.log('OK');
}).catch(e => { console.error('FAIL', e.message); process.exit(1); });
"
```
Expected: `OK` printed, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add api/_lib/auth.js
git commit -m "$(cat <<'EOF'
관리자 계정 목록 헬퍼 추가 (다중 계정 1단계)

admin:auth를 단일 객체에서 {version, accounts:[]} 구조로 전환하기 위한
헬퍼(normalizeAdminAccounts/getAdminAccounts/setAdminAccounts/findAdminAccount)와
마스터 전용 세션 검증(requireMasterAdminSession) 추가. 아직 호출하는 곳은 없음.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 로그인/세션 응답에 계정 식별 정보 반영

**Files:**
- Modify: `api/auth/[action].js`

**Interfaces:**
- Consumes: Task 1의 `getAdminAccounts()`, `findAdminAccount(accounts, id)`.
- Produces: `POST /api/auth/login` 응답에 `actorName`, `isMaster` 추가. `GET /api/auth/session` 응답에 `actorName`, `isMaster` 추가. 세션 payload에 `actorId`, `actorName`, `isMaster` 저장.

- [ ] **Step 1: import 수정 — `getRedis` 제거, 계정 헬퍼 추가**

`api/auth/[action].js` 최상단을 아래처럼 바꾼다.

기존:
```js
import { getRedis } from '../_lib/redis.js';
import {
  verifyPassword, createSession, setSessionCookie,
  checkLoginRateLimit, isSameOrigin, getClientIp,
  getSessionToken, getSession, deleteSession, clearSessionCookie,
} from '../_lib/auth.js';
import { findStudentByCredentials } from '../_lib/school.js';
```

변경 후:
```js
import {
  verifyPassword, createSession, setSessionCookie,
  checkLoginRateLimit, isSameOrigin, getClientIp,
  getSessionToken, getSession, deleteSession, clearSessionCookie,
  getAdminAccounts, findAdminAccount,
} from '../_lib/auth.js';
import { findStudentByCredentials } from '../_lib/school.js';
```
(`getRedis`는 이 파일에서 `role==='admin'` 로그인 분기에서만 쓰였고, 아래 Step 2에서 그 분기를 통째로 바꾸므로 더 이상 필요 없다.)

- [ ] **Step 2: `role==='admin'` 로그인 분기를 계정 목록 기반으로 교체**

기존:
```js
    if (role === 'admin') {
      const redis = getRedis();
      const admin = await redis.get('admin:auth');
      if (!admin || admin.id !== String(id).trim().toLowerCase() || !verifyPassword(pw, admin.pwdHash)) {
        return res.status(401).json({ success: false, message: 'ID 또는 비밀번호 오류' });
      }
      const { token, maxAge } = await createSession({ role: 'admin' });
      setSessionCookie(res, token, maxAge);
      return res.status(200).json({ success: true, role: 'admin' });
    }
```

변경 후:
```js
    if (role === 'admin') {
      const { accounts } = await getAdminAccounts();
      const account = findAdminAccount(accounts, id);
      if (!account || !verifyPassword(pw, account.pwdHash)) {
        return res.status(401).json({ success: false, message: 'ID 또는 비밀번호 오류' });
      }
      const { token, maxAge } = await createSession({
        role: 'admin', actorId: account.id, actorName: account.name, isMaster: account.isMaster === true,
      });
      setSessionCookie(res, token, maxAge);
      return res.status(200).json({
        success: true, role: 'admin', actorName: account.name, isMaster: account.isMaster === true,
      });
    }
```

- [ ] **Step 3: `session` 액션 응답에 `actorName`/`isMaster` 추가**

기존:
```js
  if (action === 'session') {
    if (req.method !== 'GET') return res.status(405).end();
    const token = getSessionToken(req);
    const session = await getSession(token);
    if (!session) return res.status(401).json({ success: false, message: '세션이 없습니다' });
    return res.status(200).json({ success: true, role: session.role });
  }
```

변경 후:
```js
  if (action === 'session') {
    if (req.method !== 'GET') return res.status(405).end();
    const token = getSessionToken(req);
    const session = await getSession(token);
    if (!session) return res.status(401).json({ success: false, message: '세션이 없습니다' });
    return res.status(200).json({
      success: true, role: session.role,
      actorName: session.actorName || '', isMaster: session.isMaster === true,
    });
  }
```

- [ ] **Step 4: 문법 검사(로컬, import만 성공하면 됨 — Redis 호출은 없음)**

Run:
```bash
node -e "import('./api/auth/[action].js').then(()=>console.log('OK')).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add "api/auth/[action].js"
git commit -m "$(cat <<'EOF'
로그인/세션 응답에 조교 계정 식별 정보(actorName/isMaster) 반영

admin 로그인이 이제 admin:auth 계정 목록에서 id를 찾아 검증하고, 세션에
actorId/actorName/isMaster를 실어 이후 활동 로그·권한 체크의 기반이 되게 함.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `credentials` 액션을 다중 계정 구조에 맞게 재정의

**Files:**
- Modify: `api/admin/[action].js` (import 구문, `credentials` 액션 블록)

**Interfaces:**
- Consumes: Task 1의 `getAdminAccounts`, `setAdminAccounts`, `findAdminAccount`.
- Produces: `POST /api/admin/credentials` — 세션의 `session.actorId`(쿠키 경로) 또는 유일한 마스터 계정(API 토큰 경로)을 "본인"으로 간주해 그 계정만 변경. 마스터가 아니면 `newId`/`newName` 요청 시 400.

- [ ] **Step 1: import에 계정 헬퍼 추가**

기존:
```js
import { requireAdminSessionOrApiToken, isSameOrigin, verifyPassword, hashPassword, encryptPwd } from '../_lib/auth.js';
```

변경 후:
```js
import {
  requireAdminSessionOrApiToken,
  isSameOrigin, verifyPassword, hashPassword, encryptPwd,
  getAdminAccounts, setAdminAccounts, findAdminAccount,
} from '../_lib/auth.js';
```
(Task 4에서 `requireMasterAdminSessionOrApiToken`/`checkRateLimit`/`getClientIp`를 이 import 목록에 추가로 더 넣는다 — 지금은 `credentials` 액션에 필요한 것만 추가한다.)

- [ ] **Step 2: `credentials` 액션 블록 전체 교체**

기존:
```js
  if (action === 'credentials') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { currentPw, newId, newPw } = req.body || {};
    if (!currentPw) return res.status(400).json({ success: false, message: '현재 비밀번호를 입력하세요' });

    const redis = getRedis();
    const admin = await redis.get('admin:auth');
    if (!admin || !verifyPassword(currentPw, admin.pwdHash)) {
      return res.status(400).json({ success: false, message: '현재 비밀번호가 틀렸습니다' });
    }
    const next = { ...admin };
    if (newId) {
      const id = String(newId).trim().toLowerCase();
      if (id.length < 4 || /\s/.test(id)) return res.status(400).json({ success: false, message: '아이디는 공백 없이 4자 이상이어야 합니다' });
      next.id = id;
    }
    if (newPw) {
      if (String(newPw).length < 4) return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });
      next.pwdHash = hashPassword(newPw);
    }
    await redis.set('admin:auth', next);
    return res.status(200).json({ success: true, id: next.id });
  }
```

변경 후:
```js
  if (action === 'credentials') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { currentPw, newId, newName, newPw } = req.body || {};
    if (!currentPw) return res.status(400).json({ success: false, message: '현재 비밀번호를 입력하세요' });

    const { version, accounts } = await getAdminAccounts();
    // 쿠키 세션이면 본인 계정(actorId), API 토큰 경로면 유일한 마스터 계정을 "본인"으로 취급
    // (이 시스템에서 마스터 계정은 항상 정확히 1개 — ta-create는 조교만 만들 수 있음)
    const targetId = session.actorId || accounts.find(a => a.isMaster === true)?.id;
    const target = findAdminAccount(accounts, targetId);
    if (!target || !verifyPassword(currentPw, target.pwdHash)) {
      return res.status(400).json({ success: false, message: '현재 비밀번호가 틀렸습니다' });
    }

    const isMaster = target.isMaster === true;
    if (!isMaster && (newId || newName)) {
      return res.status(400).json({ success: false, message: '아이디/이름 변경은 원장님 계정만 가능합니다' });
    }
    if (newId) {
      const id = String(newId).trim().toLowerCase();
      if (id.length < 4 || /\s/.test(id)) return res.status(400).json({ success: false, message: '아이디는 공백 없이 4자 이상이어야 합니다' });
      if (accounts.some(a => a.id === id && a.id !== target.id)) {
        return res.status(400).json({ success: false, message: '이미 사용 중인 아이디입니다' });
      }
      target.id = id;
    }
    if (newName) target.name = String(newName).trim();
    if (newPw) {
      if (String(newPw).length < 4) return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });
      target.pwdHash = hashPassword(newPw);
      target.passwordChangedAt = new Date().toISOString();
    }
    target.updatedAt = new Date().toISOString();
    try {
      await setAdminAccounts(accounts, version);
    } catch (e) {
      return res.status(409).json({ success: false, message: '다른 변경과 충돌했습니다. 다시 시도해주세요' });
    }
    return res.status(200).json({ success: true, id: target.id });
  }
```

주의: 이 블록은 `const session = await requireAdminSessionOrApiToken(req);`(파일 상단, 83번째 줄 부근)가 이미 실행된 뒤에 오므로 `session` 변수를 그대로 쓸 수 있다. 새로 선언하지 않는다.

- [ ] **Step 3: 로컬 문법 검사**

Run:
```bash
node -e "import('./api/admin/[action].js').then(()=>console.log('OK')).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add "api/admin/[action].js"
git commit -m "$(cat <<'EOF'
credentials 액션을 다중 계정 구조에 맞게 재정의

본인 계정(세션 actorId 또는 유일한 마스터)만 변경 가능하도록 하고, 조교
계정은 아이디/이름 변경을 서버에서 거부(비밀번호만 변경 가능)하도록 함.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `ta-list`/`ta-create`/`ta-reset-password`/`ta-delete` 액션 추가

**Files:**
- Modify: `api/admin/[action].js` (`reset-student-password` 액션 블록 뒤에 4개 액션 추가)

**Interfaces:**
- Consumes: Task 1의 `requireMasterAdminSessionOrApiToken`, `getAdminAccounts`, `setAdminAccounts`, `findAdminAccount`, `checkRateLimit`, `getClientIp`.
- Produces: `GET /api/admin/ta-list`, `POST /api/admin/ta-create`, `POST /api/admin/ta-reset-password`, `POST /api/admin/ta-delete` — 전부 마스터 전용.

- [ ] **Step 1: import에 마스터 체크/rate limit 헬퍼 추가**

Task 3에서 이미 `requireAdminSessionOrApiToken, isSameOrigin, verifyPassword, hashPassword, encryptPwd, getAdminAccounts, setAdminAccounts, findAdminAccount`까지 import하도록 바꿔놨다. 여기에 이번 태스크에서 쓰는 나머지를 추가한다.

기존(Task 3 완료 후 상태):
```js
import {
  requireAdminSessionOrApiToken,
  isSameOrigin, verifyPassword, hashPassword, encryptPwd,
  getAdminAccounts, setAdminAccounts, findAdminAccount,
} from '../_lib/auth.js';
```

변경 후:
```js
import {
  requireAdminSessionOrApiToken, requireMasterAdminSessionOrApiToken,
  isSameOrigin, verifyPassword, hashPassword, encryptPwd,
  getAdminAccounts, setAdminAccounts, findAdminAccount,
  checkRateLimit, getClientIp,
} from '../_lib/auth.js';
```

- [ ] **Step 2: `reset-student-password` 액션 블록(144~161번째 줄) 바로 뒤, `append-save-log` 액션 앞에 4개 액션 삽입**

`api/admin/[action].js`에서 아래 경계를 찾는다:
```js
    const pwd = (newPwd && String(newPwd).trim().length >= 4) ? String(newPwd).trim() : String(Math.floor(1000 + Math.random() * 9000));
    sc.students[idx].pwd = encryptPwd(pwd);
    sc.students[idx].pwdHash = hashPassword(pwd);
    sc.version = (sc.version || 0) + 1;
    await getRedis().set('school:' + schoolId, sc);
    return res.status(200).json({ success: true, password: pwd, studentId });
  }

  if (action === 'append-save-log') {
```
`reset-student-password` 블록의 닫는 `}` 다음, `append-save-log` 시작 사이에 삽입:

```js

  if (action === 'ta-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 볼 수 있습니다' });
    const { accounts } = await getAdminAccounts();
    return res.status(200).json({
      success: true,
      accounts: accounts.map(a => ({
        id: a.id, name: a.name, isMaster: a.isMaster === true,
        createdAt: a.createdAt, updatedAt: a.updatedAt, passwordChangedAt: a.passwordChangedAt,
      })),
    });
  }

  if (action === 'ta-create') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 가능합니다' });

    const rlOk = await checkRateLimit('ta-create', getClientIp(req), 10, 60);
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const { id: rawId, name, pw } = req.body || {};
    const id = String(rawId || '').trim().toLowerCase();
    if (id.length < 4 || /\s/.test(id)) return res.status(400).json({ success: false, message: '아이디는 공백 없이 4자 이상이어야 합니다' });
    if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: '이름을 입력하세요' });
    if (!pw || String(pw).length < 4) return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });

    const { version, accounts } = await getAdminAccounts();
    if (accounts.some(a => a.id === id)) return res.status(400).json({ success: false, message: '이미 사용 중인 아이디입니다' });

    const now = new Date().toISOString();
    accounts.push({
      id, name: String(name).trim(), pwdHash: hashPassword(pw), isMaster: false,
      createdAt: now, updatedAt: now, passwordChangedAt: now,
    });
    try {
      await setAdminAccounts(accounts, version);
    } catch (e) {
      return res.status(409).json({ success: false, message: '다른 변경과 충돌했습니다. 다시 시도해주세요' });
    }
    return res.status(200).json({ success: true, id, name: String(name).trim() });
  }

  if (action === 'ta-reset-password') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 가능합니다' });

    const rlOk = await checkRateLimit('ta-reset-password', getClientIp(req), 5, 60);
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const { id: rawId, newPw } = req.body || {};
    const id = String(rawId || '').trim().toLowerCase();
    const { version, accounts } = await getAdminAccounts();
    const target = findAdminAccount(accounts, id);
    if (!target) return res.status(404).json({ success: false, message: '계정을 찾을 수 없습니다' });

    const pwd = (newPw && String(newPw).trim().length >= 4) ? String(newPw).trim() : String(Math.floor(1000 + Math.random() * 9000));
    target.pwdHash = hashPassword(pwd);
    target.passwordChangedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    try {
      await setAdminAccounts(accounts, version);
    } catch (e) {
      return res.status(409).json({ success: false, message: '다른 변경과 충돌했습니다. 다시 시도해주세요' });
    }
    return res.status(200).json({ success: true, id: target.id, password: pwd });
  }

  if (action === 'ta-delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const masterCheck = await requireMasterAdminSessionOrApiToken(req);
    if (!masterCheck) return res.status(403).json({ success: false, message: '원장님 계정만 가능합니다' });

    const rlOk = await checkRateLimit('ta-delete', getClientIp(req), 5, 60);
    if (!rlOk) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });

    const { id: rawId } = req.body || {};
    const id = String(rawId || '').trim().toLowerCase();
    const { version, accounts } = await getAdminAccounts();
    const target = findAdminAccount(accounts, id);
    if (!target) return res.status(404).json({ success: false, message: '계정을 찾을 수 없습니다' });

    const remainingMasters = accounts.filter(a => a.isMaster === true && a.id !== id).length;
    if (target.isMaster === true && remainingMasters < 1) {
      return res.status(400).json({ success: false, message: '마지막 원장님 계정은 삭제할 수 없습니다' });
    }

    const next = accounts.filter(a => a.id !== id);
    try {
      await setAdminAccounts(next, version);
    } catch (e) {
      return res.status(409).json({ success: false, message: '다른 변경과 충돌했습니다. 다시 시도해주세요' });
    }
    return res.status(200).json({ success: true, id });
  }
```

- [ ] **Step 3: 로컬 문법 검사**

Run:
```bash
node -e "import('./api/admin/[action].js').then(()=>console.log('OK')).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add "api/admin/[action].js"
git commit -m "$(cat <<'EOF'
조교 계정 관리 API 추가 (ta-list/ta-create/ta-reset-password/ta-delete)

전부 마스터 전용(requireMasterAdminSessionOrApiToken), rate limit 포함.
마지막 마스터 계정 삭제는 서버에서 거부.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `migrate` 액션이 v2 구조로 쓰도록 수정

**Files:**
- Modify: `api/admin/[action].js` (`migrate` 액션 블록 내 `admin:auth` 저장 줄)

**Interfaces:**
- Consumes: 없음(기존 `hashPassword`만 사용).
- Produces: `migrate` 실행 시 `admin:auth`가 v2 구조(`{version, accounts:[...]}`)로 저장됨.

- [ ] **Step 1: `admin:auth` 저장 줄 교체**

기존:
```js
    await redis.set('admin:auth', { id: (adminId || 'admin').toLowerCase(), pwdHash: hashPassword(adminPwd || 'oheng2024') });
```

변경 후:
```js
    const nowIso = new Date().toISOString();
    await redis.set('admin:auth', {
      version: 1,
      accounts: [{
        id: (adminId || 'admin').toLowerCase(), name: '원장님', pwdHash: hashPassword(adminPwd || 'oheng2024'),
        isMaster: true, createdAt: nowIso, updatedAt: nowIso, passwordChangedAt: nowIso,
      }],
    });
```

이 줄이 있는 위치(`for (const sc of schools)` 바로 앞)와 앞뒤 코드는 그대로 둔다 — 저장하는 값의 모양만 바뀐다.

- [ ] **Step 2: 로컬 문법 검사**

Run:
```bash
node -e "import('./api/admin/[action].js').then(()=>console.log('OK')).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add "api/admin/[action].js"
git commit -m "$(cat <<'EOF'
migrate 액션이 admin:auth를 v2(다중 계정) 구조로 쓰도록 수정

이걸 놓치면 마이그레이션 한 번으로 다중 계정 구조가 단일 객체로 되돌아감.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: index.html — 로그인/세션 복원 시 `isMaster`/`actorName` 저장

**Files:**
- Modify: `index.html` (세션 복원 블록 ~line 1010, `attemptAdminLogin` ~line 1314, `doLogout` ~line 1285)

**Interfaces:**
- Consumes: Task 2의 `/api/auth/login`, `/api/auth/session` 응답 필드 `actorName`, `isMaster`.
- Produces: `ST.isMaster`(boolean), `ST.actorName`(string) — Task 7에서 UI 게이팅에 사용.

- [ ] **Step 1: 세션 복원 블록에 필드 반영**

`index.html`에서 아래 텍스트를 찾는다:
```js
      if(data.role==='admin'){
        ST.loggedIn=true;ST.role='admin';ST.school=null;ST.serverAdminSession=true;
        await loadServerSchoolsList();
      } else if(data.role==='student'){
```

변경 후:
```js
      if(data.role==='admin'){
        ST.loggedIn=true;ST.role='admin';ST.school=null;ST.serverAdminSession=true;
        ST.isMaster=!!data.isMaster;ST.actorName=data.actorName||'';
        await loadServerSchoolsList();
      } else if(data.role==='student'){
```

- [ ] **Step 2: `attemptAdminLogin`에 필드 반영**

찾는다:
```js
async function attemptAdminLogin(id,pw){
  try{
    const res=await fetch('/api/auth/login',{
      method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({role:'admin',id,pw})
    });
    if(!res.ok)return false;
    const data=await res.json();
    if(!data.success)return false;
    ST.loggedIn=true;ST.role='admin';ST.school=null;ST.serverAdminSession=true;
    await loadServerSchoolsList();
    return true;
  }catch(e){return false;}
}
```

변경 후:
```js
async function attemptAdminLogin(id,pw){
  try{
    const res=await fetch('/api/auth/login',{
      method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({role:'admin',id,pw})
    });
    if(!res.ok)return false;
    const data=await res.json();
    if(!data.success)return false;
    ST.loggedIn=true;ST.role='admin';ST.school=null;ST.serverAdminSession=true;
    ST.isMaster=!!data.isMaster;ST.actorName=data.actorName||'';
    await loadServerSchoolsList();
    return true;
  }catch(e){return false;}
}
```

- [ ] **Step 3: `doLogout`에서 필드 초기화**

찾는다:
```js
function doLogout(){
  if((ST.role==='admin'&&ST.serverAdminSession)||(ST.role==='student'&&ST.serverStudentSession)){
    fetch('/api/auth/logout',{method:'POST',credentials:'include'}).catch(()=>{});
  }
  ST.loggedIn=false;ST.serverAdminSession=false;ST.serverStudentSession=false;
  render();
}
```

변경 후:
```js
function doLogout(){
  if((ST.role==='admin'&&ST.serverAdminSession)||(ST.role==='student'&&ST.serverStudentSession)){
    fetch('/api/auth/logout',{method:'POST',credentials:'include'}).catch(()=>{});
  }
  ST.loggedIn=false;ST.serverAdminSession=false;ST.serverStudentSession=false;
  ST.isMaster=false;ST.actorName='';ST.taAccounts=undefined;
  render();
}
```

- [ ] **Step 4: 문법 검사 (기존에 확립된 방식 — 정확한 `<script>` 줄 번호로 잘라서 확인)**

Run:
```bash
grep -n '^<script>$' index.html; grep -n '^</script>$' index.html
```
Expected: 두 쌍의 줄 번호(초반 작은 블록 + 메인 앱 블록). 메인 앱 블록의 시작/끝 줄 번호를 아래 명령의 `slice` 인자에 반영한다(현재 기준 481과 4785 — Task 7까지 마친 뒤 최종적으로 한 번 더 확인).

```bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('index.html','utf8').split('\n');
const script = lines.slice(481, 4785-1).join('\n');
try { new Function(script); console.log('OK'); } catch(e) { console.log('SYNTAX ERROR:', e.message); }
"
```
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
로그인/세션 복원 시 조교 계정 식별 정보(isMaster/actorName) 클라이언트에 저장

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: index.html — "조교 계정 관리" UI 추가, 기존 아이디 변경 폼 마스터 전용으로 제한

**Files:**
- Modify: `index.html` (`rAdminSettings(sc)` 함수, 관리자 설정 탭 이벤트 바인딩 블록)

**Interfaces:**
- Consumes: Task 6의 `ST.isMaster`. `/api/admin/ta-list`(GET), `/api/admin/ta-create`(POST), `/api/admin/ta-reset-password`(POST), `/api/admin/ta-delete`(POST).
- Produces: `ST.taAccounts`(배열 또는 `null`=로딩중 또는 `undefined`=아직 안 불러옴), `fetchTaAccounts()`, `renderTaList(accounts)`.

- [ ] **Step 1: `rAdminSettings(sc)` 시작 부분에 조교 목록 지연 로딩 트리거 추가**

찾는다:
```js
function rAdminSettings(sc){
  const lastBackup=localStorage.getItem('oheng_last_backup')||'';
  const backupWarn=!lastBackup||((Date.now()-new Date(lastBackup).getTime())>7*24*60*60*1000);
  const recCount=sc.records.length;
  const weekSet=[...new Set(sc.records.map(r=>r.month+'_'+r.week))];
  return`
```

변경 후:
```js
function rAdminSettings(sc){
  const lastBackup=localStorage.getItem('oheng_last_backup')||'';
  const backupWarn=!lastBackup||((Date.now()-new Date(lastBackup).getTime())>7*24*60*60*1000);
  const recCount=sc.records.length;
  const weekSet=[...new Set(sc.records.map(r=>r.month+'_'+r.week))];
  if(ST.isMaster&&ST.taAccounts===undefined){
    ST.taAccounts=null;
    fetchTaAccounts();
  }
  return`
```

- [ ] **Step 2: "관리자 아이디 변경" 카드를 `ST.isMaster` 조건으로 감싸고, 그 뒤에 "조교 계정 관리" 카드 추가**

찾는다:
```js
  <div class="section-card">
    <div class="section-ttl">관리자 아이디 변경</div>
    <div style="font-size:12px;color:#9BA3AF;margin-bottom:12px">현재 아이디: <strong style="color:#1A237E;font-family:monospace">${ADMIN_ID}</strong></div>
    <div style="margin-bottom:12px"><label class="flbl">현재 비밀번호</label><input class="finp" type="password" id="aid-cur"></div>
    <div style="margin-bottom:14px"><label class="flbl">새 아이디</label><input class="finp" type="text" id="aid-new" placeholder="영문/숫자 4자 이상"></div>
    <button class="abtn abtn-blue" id="btn-aid-save">변경</button>
    <div id="aid-msg" style="font-size:12px;margin-top:8px"></div>
  </div>
  <div class="section-card">
    <div class="section-ttl">관리자 비밀번호 변경</div>
    <div style="margin-bottom:12px"><label class="flbl">현재 비밀번호</label><input class="finp" type="password" id="apw-cur"></div>
    <div style="margin-bottom:12px"><label class="flbl">새 비밀번호</label><input class="finp" type="password" id="apw-new" placeholder="4자 이상"></div>
    <div style="margin-bottom:14px"><label class="flbl">새 비밀번호 확인</label><input class="finp" type="password" id="apw-con"></div>
    <button class="abtn abtn-blue" id="btn-apw-save">변경</button>
    <div id="apw-msg" style="font-size:12px;margin-top:8px"></div>
    <div style="font-size:11px;color:#B0B3BF;margin-top:10px;line-height:1.6">아이디·비밀번호는 알림톡 발송과는 별개로 동작해서, 자유롭게 바꾸셔도 알림톡 발송에는 영향이 없습니다.</div>
  </div>
```

변경 후:
```js
  ${ST.isMaster?`<div class="section-card">
    <div class="section-ttl">관리자 아이디 변경</div>
    <div style="font-size:12px;color:#9BA3AF;margin-bottom:12px">현재 아이디: <strong style="color:#1A237E;font-family:monospace">${ADMIN_ID}</strong></div>
    <div style="margin-bottom:12px"><label class="flbl">현재 비밀번호</label><input class="finp" type="password" id="aid-cur"></div>
    <div style="margin-bottom:14px"><label class="flbl">새 아이디</label><input class="finp" type="text" id="aid-new" placeholder="영문/숫자 4자 이상"></div>
    <button class="abtn abtn-blue" id="btn-aid-save">변경</button>
    <div id="aid-msg" style="font-size:12px;margin-top:8px"></div>
  </div>`:''}
  <div class="section-card">
    <div class="section-ttl">비밀번호 변경</div>
    <div style="margin-bottom:12px"><label class="flbl">현재 비밀번호</label><input class="finp" type="password" id="apw-cur"></div>
    <div style="margin-bottom:12px"><label class="flbl">새 비밀번호</label><input class="finp" type="password" id="apw-new" placeholder="4자 이상"></div>
    <div style="margin-bottom:14px"><label class="flbl">새 비밀번호 확인</label><input class="finp" type="password" id="apw-con"></div>
    <button class="abtn abtn-blue" id="btn-apw-save">변경</button>
    <div id="apw-msg" style="font-size:12px;margin-top:8px"></div>
    <div style="font-size:11px;color:#B0B3BF;margin-top:10px;line-height:1.6">아이디·비밀번호는 알림톡 발송과는 별개로 동작해서, 자유롭게 바꾸셔도 알림톡 발송에는 영향이 없습니다.</div>
  </div>
  ${ST.isMaster?`<div class="section-card">
    <div class="section-ttl">👥 조교 계정 관리</div>
    <div style="font-size:12px;color:#9BA3AF;margin-bottom:14px">조교별로 별도 아이디를 만들어주면, 이후 누가 언제 뭘 했는지 구분할 수 있게 됩니다.</div>
    ${ST.taAccounts===null?`<div style="font-size:13px;color:#9BA3AF">불러오는 중...</div>`:renderTaList(ST.taAccounts||[])}
    <div style="margin-top:16px;padding-top:16px;border-top:1px solid #EEF0F4">
      <div style="font-weight:700;font-size:13px;margin-bottom:10px">새 조교 추가</div>
      <div style="margin-bottom:10px"><label class="flbl">이름</label><input class="finp" type="text" id="ta-new-name" placeholder="예: 김민지"></div>
      <div style="margin-bottom:10px"><label class="flbl">아이디</label><input class="finp" type="text" id="ta-new-id" placeholder="영문/숫자 4자 이상"></div>
      <div style="margin-bottom:14px"><label class="flbl">임시 비밀번호</label><input class="finp" type="password" id="ta-new-pw" placeholder="4자 이상"></div>
      <button class="abtn abtn-blue" id="btn-ta-create">추가</button>
      <div id="ta-create-msg" style="font-size:12px;margin-top:8px"></div>
    </div>
  </div>`:''}
```

(비밀번호 변경 카드 제목을 "관리자 비밀번호 변경"에서 "비밀번호 변경"으로 다듬었다 — 이제 조교도 이 카드를 쓰므로.)

- [ ] **Step 3: `renderTaList`/`fetchTaAccounts` 함수 추가**

`rAdminSettings` 함수 바로 뒤에 추가한다:

```js
function renderTaList(accounts){
  if(!accounts.length)return'<div style="font-size:13px;color:#9BA3AF">등록된 조교 계정이 없습니다.</div>';
  return'<table style="width:100%;border-collapse:collapse;font-size:13px">'+
    accounts.map(a=>`<tr style="border-bottom:1px solid #F0F1F5">
      <td style="padding:8px 4px">${a.name}${a.isMaster?' <span style="color:#1A237E;font-size:11px;font-weight:700">(원장님)</span>':''}</td>
      <td style="padding:8px 4px;font-family:monospace;color:#5C6470">${a.id}</td>
      <td style="padding:8px 4px;text-align:right">${a.isMaster?'':`<button class="abtn abtn-gray" data-ta-reset="${a.id}" style="padding:6px 12px;font-size:12px;margin-right:6px">비번 재설정</button><button class="abtn abtn-red" data-ta-del="${a.id}" style="padding:6px 12px;font-size:12px">삭제</button>`}</td>
    </tr>`).join('')+
    '</table>';
}
async function fetchTaAccounts(){
  try{
    const res=await fetch('/api/admin/ta-list',{credentials:'include'});
    const data=await res.json();
    ST.taAccounts=data.success?data.accounts:[];
  }catch(e){ST.taAccounts=[];}
  render();
}
```

- [ ] **Step 4: 이벤트 바인딩 추가 — `btn-apw-save` 핸들러 등록 블록 바로 뒤**

찾는다(현재 관리자 설정 탭 바인딩 블록, `btn-apw-save` 클릭 핸들러의 닫는 부분):
```js
    document.getElementById('btn-apw-save')?.addEventListener('click',async()=>{
      const cur=document.getElementById('apw-cur')?.value;const nw=document.getElementById('apw-new')?.value;const con=document.getElementById('apw-con')?.value;
      const msg=document.getElementById('apw-msg');
      if(!nw||nw.length<4){msg.textContent='4자 이상 입력하세요';msg.style.color='#E53935';return;}
      if(nw!==con){msg.textContent='비밀번호가 일치하지 않습니다';msg.style.color='#E53935';return;}
      if(ST.serverAdminSession){
        try{
          const res=await fetch('/api/admin/credentials',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPw:cur,newPw:nw})});
          const data=await res.json();
          if(!res.ok||!data.success){msg.textContent=data.message||'변경 실패';msg.style.color='#E53935';return;}
        }catch(e){msg.textContent='오류: '+e.message;msg.style.color='#E53935';return;}
      } else {
        if(cur!==ADMIN_PWD){msg.textContent='현재 비밀번호가 틀렸습니다';msg.style.color='#E53935';return;}
        ADMIN_PWD=nw;saveDB();
      }
      msg.textContent='✓ 변경 완료';msg.style.color='#00897B';
    });
```
그 다음 줄(`// 새 학기 시작` 주석 앞)에 삽입:

```js
    document.getElementById('btn-ta-create')?.addEventListener('click',async()=>{
      const name=document.getElementById('ta-new-name')?.value.trim();
      const id=document.getElementById('ta-new-id')?.value.trim();
      const pw=document.getElementById('ta-new-pw')?.value;
      const msg=document.getElementById('ta-create-msg');
      if(!name){msg.textContent='이름을 입력하세요';msg.style.color='#E53935';return;}
      try{
        const res=await fetch('/api/admin/ta-create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name,pw})});
        const data=await res.json();
        if(!res.ok||!data.success){msg.textContent=data.message||'추가 실패';msg.style.color='#E53935';return;}
      }catch(e){msg.textContent='오류: '+e.message;msg.style.color='#E53935';return;}
      msg.textContent='✓ 추가 완료';msg.style.color='#00897B';
      ST.taAccounts=undefined;
      setTimeout(()=>render(),600);
    });
    document.querySelectorAll('[data-ta-reset]').forEach(b=>{
      b.onclick=async()=>{
        const id=b.dataset.taReset;
        if(!confirm(`${id} 계정의 비밀번호를 재설정합니다. 계속하시겠습니까?`))return;
        try{
          const res=await fetch('/api/admin/ta-reset-password',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
          const data=await res.json();
          if(!res.ok||!data.success){alert(data.message||'재설정 실패');return;}
          alert(`새 임시 비밀번호: ${data.password}\n조교에게 전달해주세요.`);
        }catch(e){alert('오류: '+e.message);}
      };
    });
    document.querySelectorAll('[data-ta-del]').forEach(b=>{
      b.onclick=async()=>{
        const id=b.dataset.taDel;
        if(!confirm(`${id} 계정을 삭제합니다. 되돌릴 수 없습니다. 계속하시겠습니까?`))return;
        try{
          const res=await fetch('/api/admin/ta-delete',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
          const data=await res.json();
          if(!res.ok||!data.success){alert(data.message||'삭제 실패');return;}
        }catch(e){alert('오류: '+e.message);return;}
        ST.taAccounts=undefined;
        render();
      };
    });
```

- [ ] **Step 5: 문법 검사**

Run:
```bash
grep -n '^<script>$' index.html; grep -n '^</script>$' index.html
```
그 결과의 메인 앱 블록 줄 번호로 아래를 실행(현재 예상 481~4785 근방이나 Step 1~4에서 줄 수가 늘었으니 실제 grep 결과 값을 넣는다):
```bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('index.html','utf8').split('\n');
const script = lines.slice(<시작줄-1>, <끝줄-1>).join('\n');
try { new Function(script); console.log('OK'); } catch(e) { console.log('SYNTAX ERROR:', e.message); }
"
```
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
관리자 설정에 '조교 계정 관리' 화면 추가 (마스터 전용)

조교 목록 조회/추가/비번재설정/삭제 UI + API 연동. 기존 '관리자 아이디
변경' 폼은 마스터에게만 노출(조교는 서버에서도 거부되므로 UI에서도 숨김).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 배포 + 종단 검증

**Files:** 없음(배포 및 curl 검증만).

**Interfaces:** 없음.

- [ ] **Step 1: Push해서 배포 트리거**

```bash
git push origin main
```

- [ ] **Step 2: 배포 완료 대기 (버전 엔드포인트로 확인)**

```bash
git rev-parse HEAD
```
그 SHA가 나올 때까지 반복 확인(최대 몇 분):
```bash
curl -s https://oheng.vercel.app/api/version
```
Expected: 응답의 `sha`가 위 `git rev-parse HEAD` 결과와 일치.

- [ ] **Step 3: 마스터(기존 admin) 계정으로 로그인 → 세션에 isMaster:true 확인**

```bash
curl -sc /tmp/oheng-cookies.txt -X POST https://oheng.vercel.app/api/auth/login \
  -H "Content-Type: application/json" -H "Origin: https://oheng.vercel.app" \
  -d '{"role":"admin","id":"<실제 관리자 아이디>","pw":"<실제 관리자 비밀번호>"}'
```
Expected: `{"success":true,"role":"admin","actorName":"원장님","isMaster":true}`

```bash
curl -sb /tmp/oheng-cookies.txt https://oheng.vercel.app/api/auth/session
```
Expected: `{"success":true,"role":"admin","actorName":"원장님","isMaster":true}`

- [ ] **Step 4: 마스터 세션으로 조교 계정 생성 → 목록 조회**

```bash
curl -sb /tmp/oheng-cookies.txt -X POST https://oheng.vercel.app/api/admin/ta-create \
  -H "Content-Type: application/json" -H "Origin: https://oheng.vercel.app" \
  -d '{"id":"ta_test1","name":"테스트조교","pw":"test1234"}'
```
Expected: `{"success":true,"id":"ta_test1","name":"테스트조교"}`

```bash
curl -sb /tmp/oheng-cookies.txt https://oheng.vercel.app/api/admin/ta-list
```
Expected: `accounts` 배열에 기존 마스터 계정 + `ta_test1` 두 건, `pwdHash` 필드는 어디에도 없음.

- [ ] **Step 5: 새 조교 계정으로 로그인 → 전체 학교 접근 가능 + 마스터 전용 API는 거부되는지 확인**

```bash
curl -sc /tmp/oheng-ta-cookies.txt -X POST https://oheng.vercel.app/api/auth/login \
  -H "Content-Type: application/json" -H "Origin: https://oheng.vercel.app" \
  -d '{"role":"admin","id":"ta_test1","pw":"test1234"}'
```
Expected: `{"success":true,"role":"admin","actorName":"테스트조교","isMaster":false}`

```bash
curl -sb /tmp/oheng-ta-cookies.txt https://oheng.vercel.app/api/admin/schools
```
Expected: 200, 전체 학교 목록 정상 반환(조교도 오늘과 동일하게 전체 접근).

```bash
curl -sb /tmp/oheng-ta-cookies.txt https://oheng.vercel.app/api/admin/ta-list
```
Expected: `{"success":false,"message":"원장님 계정만 볼 수 있습니다"}` (403).

```bash
curl -sb /tmp/oheng-ta-cookies.txt -X POST https://oheng.vercel.app/api/admin/credentials \
  -H "Content-Type: application/json" -H "Origin: https://oheng.vercel.app" \
  -d '{"currentPw":"test1234","newId":"hacker"}'
```
Expected: `{"success":false,"message":"아이디/이름 변경은 원장님 계정만 가능합니다"}` (400).

- [ ] **Step 6: 마지막 마스터 계정 삭제 시도가 거부되는지 확인**

마스터 쿠키로 마스터 계정 자신의 id를 대상으로 `ta-delete` 시도(실제 관리자 아이디로 교체):
```bash
curl -sb /tmp/oheng-cookies.txt -X POST https://oheng.vercel.app/api/admin/ta-delete \
  -H "Content-Type: application/json" -H "Origin: https://oheng.vercel.app" \
  -d '{"id":"<실제 관리자 아이디>"}'
```
Expected: `{"success":false,"message":"마지막 원장님 계정은 삭제할 수 없습니다"}` (400).

- [ ] **Step 7: 테스트용 조교 계정 정리**

```bash
curl -sb /tmp/oheng-cookies.txt -X POST https://oheng.vercel.app/api/admin/ta-delete \
  -H "Content-Type: application/json" -H "Origin: https://oheng.vercel.app" \
  -d '{"id":"ta_test1"}'
```
Expected: `{"success":true,"id":"ta_test1"}`

- [ ] **Step 8: 브라우저에서 실제 화면 확인**

마스터 계정으로 `https://oheng.vercel.app`에 로그인 → 관리자 설정 탭 → "조교 계정 관리" 카드가 보이는지, 추가/재설정/삭제 버튼이 실제로 동작하는지 눈으로 확인. 새 조교 계정으로 별도 브라우저(시크릿 창)에서 로그인해 해당 카드와 "관리자 아이디 변경" 카드가 안 보이는지, "비밀번호 변경" 카드는 보이고 정상 동작하는지 확인.
