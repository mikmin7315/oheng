# 강좌 카탈로그 · 열람 · 수동 수강권 부여 (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 강좌(course) 데이터 모델과 열람 API를 만들고, `lecture.html`을 "비로그인 강좌 둘러보기 → 휴대폰 인증 가입/로그인(Phase 1 재사용) → 내가 구매한 강좌의 영상 목록"까지 완결된 흐름으로 개편한다. 실제 결제(포트원 연동)는 이 계획 범위 밖이며, 대신 관리자가 curl로 수강권(entitlement)을 수동 부여/회수할 수 있는 API를 만들어 결제 없이도 전체 흐름을 종단 검증할 수 있게 한다.

**Architecture:** `api/_lib/course.js`를 신설해 기존 `api/_lib/video.js`(`video:{id}`)와 동일한 패턴(`course:index` + `course:{id}`)으로 강좌를 저장한다. 접근권한 판단 함수 `canMemberAccessVideo(video, member, courses)`는 `api/_lib/video.js`에 추가하되, `course.js`가 이미 `video.js`를 가져다 쓰므로(`listAllVideos`) 순환 import를 피하기 위해 courses 배열을 인자로 받는 순수 함수로 만든다(호출부인 `course.js`가 미리 강좌 목록을 조회해서 넘김). API는 기존 `api/videos/[action].js` 라우트와 동일한 구조로 `api/courses/[action].js` 하나에 통합한다(Vercel Hobby 12개 함수 제한 고려). `lecture.html`은 기존 학생용 화면 로직은 그대로 두고, 기본 화면을 "강좌 둘러보기"로 바꾸며 Phase 1에서 만든 `/api/member-auth/*` 엔드포인트를 그대로 재사용한다.

**Tech Stack:** Node.js(Vercel Serverless Functions), Upstash Redis(`@upstash/redis`). 새 의존성 없음.

## Global Constraints

- 이 프로젝트는 **자동화 테스트 프레임워크가 없다**. "테스트" 단계는 `node --check`로 문법 검증 + 배포 후 curl/브라우저로 실제 동작을 확인하는 방식이다(Phase 1과 동일한 검증 방식).
- Vercel Hobby 플랜 서버리스 함수 12개 제한. Phase 1 완료 시점 기준 9개 사용 중(`api/admin/[action].js`, `api/admin/school/[id].js`, `api/auth/[action].js`, `api/member-auth/[action].js`, `api/push.js`, `api/send.js`, `api/student/[action].js`, `api/subscribe.js`, `api/videos/[action].js`). 이 계획은 `api/courses/[action].js` 파일 하나만 추가해 10개로 만든다 — 강좌 관련 액션(공개 목록/내 강좌/관리자 CRUD/수강권 수동 부여·회수)을 전부 이 한 파일에 통합하고, 액션마다 새 파일을 만들지 않는다. (다음 결제 Phase에서 1개 더 추가할 여유를 남겨둔다.)
- 세션/쿠키/CSRF(`isSameOrigin`) 패턴은 기존 `api/videos/[action].js`, `api/member-auth/[action].js`와 완전히 동일하게 따른다.
- **이번 대화에서 `index.html`(oheng.vercel.app, 성적관리 앱)은 건드리지 않는다.** 강좌 관리자 CRUD는 전용 관리 화면 없이 `API_AUTH_TOKEN`(`requireAdminSessionOrApiToken`의 API 토큰 경로, 기존에도 curl/스크립트용으로 쓰던 방식) 기반 curl 호출로만 수행한다. `vercel.json`의 host 기반 rewrite는 `oheng.co.kr`/`www.oheng.co.kr`에만 적용되므로 `oheng.vercel.app`의 동작(=`index.html` 서빙)에는 영향이 없다.
- 결제(포트원) 연동은 이 계획 범위 밖이다 — `docs/superpowers/specs/2026-07-21-member-course-payments-design.md`의 "강좌 열람 & 구매" 섹션 중 `create-order`/`confirm`/웹훅 부분은 다음 Phase(포트원 가맹점 계정 인증 완료 후)에서 다룬다. 이 계획은 그 앞 단계인 강좌 모델·열람·(결제 대신) 수동 수강권 부여까지다.
- 검증은 실제 배포된 `https://oheng.co.kr`에 대해 진행한다(별도 스테이징 없음). OTP 로그인 검증에는 실제 휴대폰 번호가 필요하며 SMS 비용이 발생한다 — Phase 1에서 이미 검증된 흐름이므로 이번엔 재사용 관점에서 가볍게만 재확인한다.
- **의도적으로 축소한 범위:** 설계 문서 에러 처리 표의 "수강기간 만료 후 접근 시도 → 목록엔 '만료됨'으로 표시"는 이번 계획에서 구현하지 않는다. `listVideosForMember`는 active + 미만료 수강권만 반환하므로 만료된 강좌는 목록에서 그냥 사라진다(회색조 "만료됨" 라벨 없음). 어차피 콜러스 연동 전까지는 모든 영상이 재생 잠금 placeholder이므로 실질적인 접근 차단 효과는 없어 이번 단계에서는 우선순위가 낮다고 판단함 — 실제 재생 연동 단계에서 함께 다듬는다.

---

### Task 1: `canMemberAccessVideo` 헬퍼 추가

**Files:**
- Modify: `api/_lib/video.js` (파일 끝에 추가)

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces: `canMemberAccessVideo(video: Video, member: Member, courses: Course[]): boolean` — Task 2의 `listVideosForMember`에서 사용.

- [ ] **Step 1: `canMemberAccessVideo` 추가**

`api/_lib/video.js` 파일 맨 끝에 다음을 추가한다:

```js

// 회원이 강좌를 구매해 이 영상에 접근 가능한지 확인.
// course.js가 이 파일의 listAllVideos를 가져다 쓰므로, 순환 import를 피하기 위해
// courses 목록은 이 함수가 직접 조회하지 않고 호출부(course.js)가 미리 조회해서 넘긴다.
export function canMemberAccessVideo(video, member, courses) {
  const now = Date.now();
  const activeCourseIds = new Set(
    (member.entitlements || [])
      .filter(e => e.status === 'active' && new Date(e.expiresAt).getTime() > now)
      .map(e => e.courseId)
  );
  return courses.some(c => activeCourseIds.has(c.id) && (c.videoIds || []).includes(video.id));
}
```

- [ ] **Step 2: 문법 검증**

Run: `cd C:/Users/mikmi/oheng && node --check api/_lib/video.js`
Expected: 아무 출력 없이 종료 (에러 없음)

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add api/_lib/video.js
git commit -m "canMemberAccessVideo 헬퍼 추가 — 회원 강좌 구매 기반 영상 접근권한 판단"
```

---

### Task 2: 강좌 데이터 헬퍼 (`api/_lib/course.js`)

**Files:**
- Create: `api/_lib/course.js`

**Interfaces:**
- Consumes: `api/_lib/redis.js`의 `getRedis()`, `api/_lib/video.js`의 `listAllVideos()`·`canMemberAccessVideo()` (Task 1)
- Produces:
  - `getCourseIndex(): Promise<string[]>`
  - `getCourse(id: string): Promise<Course|null>`
  - `listAllCourses(): Promise<Course[]>`
  - `saveCourse(incoming: object): Promise<Course>`
  - `deleteCourse(id: string): Promise<void>`
  - `listPublishedCoursesForPublic(): Promise<PublicCourse[]>`
  - `listVideosForMember(member: Member): Promise<MemberVideo[]>`
  - `Course` 형태: `{ id, title, description, price, durationDays, videoIds, published, createdAt, updatedAt }`
  이 함수들을 Task 4의 `api/courses/[action].js`에서 사용한다.

- [ ] **Step 1: `api/_lib/course.js` 작성**

```js
import { getRedis } from './redis.js';
import { listAllVideos, canMemberAccessVideo } from './video.js';

const COURSE_PREFIX = 'course:';
const COURSE_INDEX_KEY = 'course:index';

export async function getCourseIndex() {
  const redis = getRedis();
  const idx = await redis.get(COURSE_INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

export async function getCourse(id) {
  const redis = getRedis();
  return await redis.get(COURSE_PREFIX + id);
}

export async function listAllCourses() {
  const index = await getCourseIndex();
  const courses = await Promise.all(index.map(id => getCourse(id)));
  return courses.filter(Boolean);
}

function normalizeCourse(incoming, existing) {
  return {
    id: existing?.id || incoming.id || ('crs' + Date.now()),
    title: String(incoming.title || '').trim(),
    description: String(incoming.description || '').trim(),
    price: Math.max(0, parseInt(incoming.price, 10) || 0),
    durationDays: Math.max(1, parseInt(incoming.durationDays, 10) || 30),
    videoIds: Array.isArray(incoming.videoIds) ? incoming.videoIds : [],
    published: !!incoming.published,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function saveCourse(incoming) {
  const redis = getRedis();
  const existing = incoming.id ? await getCourse(incoming.id) : null;
  const course = normalizeCourse(incoming, existing);
  await redis.set(COURSE_PREFIX + course.id, course);
  if (!existing) {
    const index = await getCourseIndex();
    if (!index.includes(course.id)) {
      index.push(course.id);
      await redis.set(COURSE_INDEX_KEY, index);
    }
  }
  return course;
}

export async function deleteCourse(id) {
  const redis = getRedis();
  await redis.del(COURSE_PREFIX + id);
  const index = await getCourseIndex();
  await redis.set(COURSE_INDEX_KEY, index.filter(x => x !== id));
}

// 비로그인 둘러보기용 — published인 것만, 공개 가능한 필드만(관리자 전용 필드 제외)
export async function listPublishedCoursesForPublic() {
  const all = await listAllCourses();
  return all
    .filter(c => c.published)
    .map(c => ({
      id: c.id, title: c.title, description: c.description,
      price: c.price, durationDays: c.durationDays, videoCount: (c.videoIds || []).length,
    }));
}

// 회원이 실제 구매(active + 미만료)한 강좌들의 영상 목록.
// /api/videos/mine과 같은 필드 모양(id/title/month/week/mediaKey)에 courseId/courseTitle을 더해
// lecture.html의 기존 렌더링 로직을 재사용하면서 강좌 단위로도 묶을 수 있게 한다.
export async function listVideosForMember(member) {
  const courses = await listAllCourses();
  const videos = await listAllVideos();
  const accessible = videos.filter(v => canMemberAccessVideo(v, member, courses));
  return accessible.map(v => {
    const owner = courses.find(c => (c.videoIds || []).includes(v.id));
    return {
      id: v.id, title: v.title, month: v.month, week: v.week, mediaKey: v.mediaKey,
      courseId: owner ? owner.id : null, courseTitle: owner ? owner.title : '',
    };
  });
}
```

- [ ] **Step 2: 문법 검증**

Run: `cd C:/Users/mikmi/oheng && node --check api/_lib/course.js`
Expected: 아무 출력 없이 종료

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add api/_lib/course.js
git commit -m "강좌 데이터 헬퍼(api/_lib/course.js) 추가 — CRUD + 공개목록 + 회원별 영상목록"
```

---

### Task 3: 회원 수강권(entitlement) 갱신 헬퍼 추가

**Files:**
- Modify: `api/_lib/member.js` (파일 끝에 추가)

**Interfaces:**
- Consumes: 이 파일에 이미 있는 `getMember(id)` (수정 없음)
- Produces: `updateMemberEntitlements(id: string, entitlements: Entitlement[]): Promise<Member|null>` — Task 4의 수동 수강권 부여/회수 액션에서 사용.

- [ ] **Step 1: `updateMemberEntitlements` 추가**

`api/_lib/member.js` 파일 맨 끝에 다음을 추가한다:

```js

export async function updateMemberEntitlements(id, entitlements) {
  const redis = getRedis();
  const member = await getMember(id);
  if (!member) return null;
  member.entitlements = entitlements;
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
git commit -m "회원 수강권 갱신 헬퍼(updateMemberEntitlements) 추가"
```

---

### Task 4: `api/courses/[action].js` 라우트

**Files:**
- Create: `api/courses/[action].js`

**Interfaces:**
- Consumes:
  - `api/_lib/auth.js`: `requireAdminSessionOrApiToken`, `requireMemberSession`, `isSameOrigin` (기존)
  - `api/_lib/member.js`: `getMember`, `updateMemberEntitlements` (Task 3)
  - `api/_lib/course.js`: `listAllCourses`, `getCourse`, `saveCourse`, `deleteCourse`, `listPublishedCoursesForPublic`, `listVideosForMember` (Task 2)
- Produces: 아래 7개 엔드포인트. `lecture.html`(Task 6)과 다음 결제 Phase가 재사용한다.
  - `GET /api/courses/list` (비로그인 가능) → `{ success: true, courses: [{id,title,description,price,durationDays,videoCount}] }`
  - `GET /api/courses/mine` (회원 세션 필요) → `{ success: true, videos: [{id,title,month,week,mediaKey,courseId,courseTitle}] }`
  - `GET /api/courses/admin-list` (관리자) → `{ success: true, courses: Course[] }` (전체 필드, 미공개 포함)
  - `POST /api/courses/save { id?, title, description, price, durationDays, videoIds, published }` (관리자) → `{ success: true, course }`
  - `POST /api/courses/delete { id }` (관리자) → `{ success: true }`
  - `POST /api/courses/grant-entitlement { memberId, courseId, days? }` (관리자, 결제 없이 수강권 수동 부여 — 현금 결제/이벤트/QA용) → `{ success: true, member }`
  - `POST /api/courses/revoke-entitlement { memberId, courseId }` (관리자, 환불/취소 시 수동 회수) → `{ success: true, member }`

- [ ] **Step 1: `api/courses/[action].js` 작성**

```js
import { requireAdminSessionOrApiToken, requireMemberSession, isSameOrigin } from '../_lib/auth.js';
import { getMember, updateMemberEntitlements } from '../_lib/member.js';
import {
  listAllCourses, getCourse, saveCourse, deleteCourse,
  listPublishedCoursesForPublic, listVideosForMember,
} from '../_lib/course.js';

export default async function handler(req, res) {
  const { action } = req.query;

  if (action === 'list') {
    if (req.method !== 'GET') return res.status(405).end();
    const courses = await listPublishedCoursesForPublic();
    return res.status(200).json({ success: true, courses });
  }

  if (action === 'mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const session = await requireMemberSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const member = await getMember(session.memberId);
    if (!member) return res.status(404).json({ success: false, message: '회원 정보를 찾을 수 없습니다' });
    const videos = await listVideosForMember(member);
    return res.status(200).json({ success: true, videos });
  }

  const admin = await requireAdminSessionOrApiToken(req);
  if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (action === 'admin-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const courses = await listAllCourses();
    return res.status(200).json({ success: true, courses });
  }

  if (action === 'save') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { title } = req.body || {};
    if (!String(title || '').trim()) return res.status(400).json({ success: false, message: '제목을 입력하세요' });
    const course = await saveCourse(req.body || {});
    return res.status(200).json({ success: true, course });
  }

  if (action === 'delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
    await deleteCourse(id);
    return res.status(200).json({ success: true });
  }

  // 결제 연동 전까지, 현금 결제/이벤트/QA 목적으로 관리자가 수강권을 직접 부여한다.
  if (action === 'grant-entitlement') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { memberId, courseId, days } = req.body || {};
    if (!memberId || !courseId) return res.status(400).json({ success: false, message: 'Missing memberId/courseId' });
    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ success: false, message: '회원을 찾을 수 없습니다' });
    const course = await getCourse(courseId);
    if (!course) return res.status(404).json({ success: false, message: '강좌를 찾을 수 없습니다' });
    const durationDays = Math.max(1, parseInt(days, 10) || course.durationDays || 30);
    const expiresAt = new Date(Date.now() + durationDays * 86400000).toISOString();
    const entitlements = (member.entitlements || []).filter(e => e.courseId !== courseId);
    entitlements.push({
      courseId, purchasedAt: new Date().toISOString(), expiresAt,
      paymentId: 'manual', amount: 0, status: 'active',
    });
    const updated = await updateMemberEntitlements(memberId, entitlements);
    return res.status(200).json({ success: true, member: updated });
  }

  // 환불/취소 시 관리자가 수강권을 회수한다(설계 문서: 자동 환불은 범위 밖, 수동 처리).
  if (action === 'revoke-entitlement') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { memberId, courseId } = req.body || {};
    if (!memberId || !courseId) return res.status(400).json({ success: false, message: 'Missing memberId/courseId' });
    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ success: false, message: '회원을 찾을 수 없습니다' });
    const entitlements = (member.entitlements || []).map(e =>
      e.courseId === courseId ? { ...e, status: 'revoked' } : e);
    const updated = await updateMemberEntitlements(memberId, entitlements);
    return res.status(200).json({ success: true, member: updated });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
```

- [ ] **Step 2: 문법 검증**

Run: `cd C:/Users/mikmi/oheng && node --check "api/courses/[action].js"`
Expected: 아무 출력 없이 종료

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add "api/courses/[action].js"
git commit -m "강좌 열람/관리/수동 수강권 부여 라우트(api/courses/[action].js) 추가"
```

---

### Task 5: `oheng.co.kr` 루트를 `lecture.html`로 라우팅

**Files:**
- Modify: `vercel.json`

**Interfaces:**
- Consumes: 없음
- Produces: `oheng.co.kr`/`www.oheng.co.kr`의 `/` 요청이 `lecture.html`로 서빙됨. `oheng.vercel.app`은 영향 없음(계속 `index.html`).

**배경:** 설계 문서(`docs/superpowers/specs/2026-07-21-member-course-payments-design.md`)는 "`oheng.co.kr`은 Vercel 호스트 기반 rewrite로 `/` 요청을 `lecture.html`로 보낸다"고 명시하지만, 실제로는 아직 `vercel.json`에 반영되어 있지 않아 지금 `oheng.co.kr/`은 `index.html`(성적관리 앱)을 서빙하고 있다(직접 확인함: `curl https://oheng.co.kr/` → `<title>OHENG 성적 관리</title>`). 이 태스크는 그 격차를 메운다. `index.html` 자체는 건드리지 않는다.

- [ ] **Step 1: `vercel.json`에 host 기반 rewrite 추가**

`vercel.json`을 다음으로 교체한다:

```json
{
  "crons": [
    { "path": "/api/admin/backup-run", "schedule": "0 19 * * 0" }
  ],
  "rewrites": [
    { "source": "/", "has": [{ "type": "host", "value": "oheng.co.kr" }], "destination": "/lecture.html" },
    { "source": "/", "has": [{ "type": "host", "value": "www.oheng.co.kr" }], "destination": "/lecture.html" }
  ]
}
```

- [ ] **Step 2: JSON 문법 검증**

Run: `cd C:/Users/mikmi/oheng && node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('OK')"`
Expected: `OK` 출력

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add vercel.json
git commit -m "oheng.co.kr/www 루트를 lecture.html로 라우팅하는 host rewrite 추가"
```

---

### Task 6: `lecture.html` 개편 — 강좌 둘러보기 + 휴대폰 인증 가입/로그인 + 내 강좌

**Files:**
- Modify: `lecture.html` (전체 교체)

**Interfaces:**
- Consumes: `GET /api/courses/list`, `GET /api/courses/mine`, `POST /api/member-auth/otp-request`, `POST /api/member-auth/otp-verify`, `POST /api/member-auth/profile`, `GET /api/member-auth/me`, `POST /api/member-auth/logout` (Phase 1 + Task 4), 기존 `GET /api/auth/session`, `GET /api/student/me`, `GET /api/videos/mine`, `POST /api/auth/login`, `POST /api/auth/logout` (변경 없음)
- Produces: 없음(최종 화면)

**화면 흐름:** 비로그인 기본 화면은 "강좌 둘러보기"(`browse`). 여기서 "휴대폰 인증하고 시작하기"를 누르면 `otp-phone` → `otp-code` → (신규 회원이면) `otp-name` 순으로 진행하고, 완료되면 회원의 `내 강좌` 목록(`list`, 강좌별 그룹)으로 이동한다. "학원 학생이신가요?" 링크로 기존 학생 로그인(`student-login`)에도 진입할 수 있다. 이미 로그인된 세션(학생 또는 회원)이 있으면 부팅 시 바로 해당 목록 화면으로 간다. 실제 강좌 "구매하기" 버튼은 결제 연동 전까지는 만들지 않는다(눌러도 아무 동작 안 하는 버튼을 두지 않기 위함) — 강좌 카드는 정보 표시(제목/설명/가격/영상수/기간)만 하고, 구매는 다음 Phase(포트원 연동)에서 추가한다.

- [ ] **Step 1: `lecture.html` 전체 교체**

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>OHENG 인강</title>
<meta name="theme-color" content="#0B0F1A">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;background:#0B0F1A;color:#E8ECF4;min-height:100dvh}
  #app{min-height:100dvh;display:flex;flex-direction:column}
  .top{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #1C2333;position:sticky;top:0;background:#0B0F1A;z-index:10}
  .brand{display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;letter-spacing:-0.3px}
  .brand .dot{width:8px;height:8px;border-radius:50%;background:#FFB300}
  .who{font-size:12px;color:#8A93A8}
  .btn{padding:8px 14px;border-radius:8px;border:1px solid #2A3247;background:#141A28;color:#C8CFDD;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
  .btn:hover{background:#1A2135}
  .btn-primary{background:#4C5FD5;border-color:#4C5FD5;color:#fff}
  .btn-primary:hover{background:#5A6CE0}
  .btn-primary:disabled{opacity:0.5;cursor:default}
  .link-btn{background:none;border:none;color:#8A93A8;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:underline}
  .link-btn:hover{color:#C8CFDD}
  main{flex:1;padding:24px 20px 60px;max-width:720px;margin:0 auto;width:100%}

  /* 로그인/인증 */
  .login-wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:20px}
  .login-card{width:100%;max-width:340px;background:#111726;border:1px solid #1C2333;border-radius:18px;padding:32px 28px}
  .login-title{font-size:20px;font-weight:800;margin-bottom:4px}
  .login-sub{font-size:12.5px;color:#8A93A8;margin-bottom:24px}
  .finp{width:100%;padding:12px 14px;border-radius:10px;border:1.5px solid #2A3247;background:#0B0F1A;color:#E8ECF4;font-size:14px;font-family:inherit;margin-bottom:10px;outline:none}
  .finp:focus{border-color:#4C5FD5}
  .login-err{font-size:12px;color:#F87171;min-height:16px;margin-bottom:8px}
  .login-foot{margin-top:16px;text-align:center}

  /* 강좌 둘러보기 */
  .intro{text-align:center;padding:36px 20px 28px}
  .intro-title{font-size:22px;font-weight:800;margin-bottom:6px}
  .intro-sub{font-size:13px;color:#8A93A8;margin-bottom:20px}
  .course-card{background:#111726;border:1px solid #1C2333;border-radius:14px;padding:18px;margin-bottom:12px}
  .course-title{font-size:15.5px;font-weight:700;margin-bottom:6px}
  .course-desc{font-size:12.5px;color:#8A93A8;margin-bottom:12px;line-height:1.5}
  .course-meta{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;color:#7B8499}
  .course-price{font-size:15px;font-weight:800;color:#FFB300}

  /* 목록 */
  .wk-head{font-size:12px;font-weight:700;color:#7B8499;margin:22px 0 10px;letter-spacing:0.3px}
  .wk-head:first-child{margin-top:0}
  .vcard{background:#111726;border:1px solid #1C2333;border-radius:14px;padding:16px;margin-bottom:10px;cursor:pointer;transition:border-color .15s}
  .vcard:hover{border-color:#3A4260}
  .vcard-title{font-size:14.5px;font-weight:700;display:flex;align-items:center;gap:8px}
  .empty{text-align:center;padding:80px 20px;color:#5C6478}
  .empty .ic{font-size:38px;margin-bottom:14px}

  /* 재생 화면 */
  .player-back{background:none;border:none;color:#8A93A8;font-size:13px;cursor:pointer;margin-bottom:16px;font-family:inherit;display:flex;align-items:center;gap:6px}
  .player-back:hover{color:#E8ECF4}
  .player-title{font-size:19px;font-weight:800;margin-bottom:4px}
  .player-wk{font-size:12.5px;color:#8A93A8;margin-bottom:20px}
  .player-box{background:#000;border-radius:16px;aspect-ratio:16/9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#5C6478;text-align:center;padding:24px}
  .player-box .ic{font-size:34px}
  .player-box .msg{font-size:13.5px;color:#8A93A8}
  .player-box .sub{font-size:11.5px;color:#4B5468}

  .loading{flex:1;display:flex;align-items:center;justify-content:center;color:#5C6478;font-size:13px}
</style>
</head>
<body>
<div id="app"></div>
<script>
const ST={screen:'loading',mode:null,student:null,member:null,videos:null,active:null,courses:null,otpPhone:''};

function esc(str){return String(str??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
const MONTHS=['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
const WEEKS=['1주','2주','3주','4주','5주'];
function moI(m){return MONTHS.indexOf(m)}
function wkI(w){return WEEKS.indexOf(w)}
function won(n){return (n||0).toLocaleString('ko-KR')+'원';}

/* ── 데이터 로드 ── */
async function checkStudentSession(){
  try{
    const res=await fetch('/api/auth/session',{credentials:'include'});
    if(!res.ok)return false;
    const d=await res.json();
    return d.success && d.role==='student';
  }catch(e){return false;}
}
async function loadStudentMe(){
  try{
    const res=await fetch('/api/student/me',{credentials:'include'});
    if(!res.ok)return null;
    const d=await res.json();
    return d.success?d:null;
  }catch(e){return null;}
}
async function loadStudentVideos(){
  try{
    const res=await fetch('/api/videos/mine',{credentials:'include'});
    const d=await res.json();
    return d.success?d.videos:[];
  }catch(e){return [];}
}
async function loadMemberMe(){
  try{
    const res=await fetch('/api/member-auth/me',{credentials:'include'});
    if(!res.ok)return null;
    const d=await res.json();
    return d.success?d.member:null;
  }catch(e){return null;}
}
async function loadMemberVideos(){
  try{
    const res=await fetch('/api/courses/mine',{credentials:'include'});
    const d=await res.json();
    return d.success?d.videos:[];
  }catch(e){return [];}
}
async function loadPublicCourses(){
  try{
    const res=await fetch('/api/courses/list');
    const d=await res.json();
    return d.success?d.courses:[];
  }catch(e){return [];}
}

async function boot(){
  const studentOk=await checkStudentSession();
  if(studentOk){
    const me=await loadStudentMe();
    if(me){
      ST.mode='student';ST.student=me;ST.videos=await loadStudentVideos();ST.screen='list';render();return;
    }
  }
  const member=await loadMemberMe();
  if(member){
    ST.mode='member';ST.member=member;ST.videos=await loadMemberVideos();ST.screen='list';render();return;
  }
  ST.mode=null;
  ST.courses=await loadPublicCourses();
  ST.screen='browse';
  render();
}

/* ── 액션 ── */
async function doStudentLogin(id,pw,errEl,btn){
  errEl.textContent='';btn.disabled=true;btn.textContent='로그인 중...';
  try{
    const res=await fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'student',id,pw})});
    const d=await res.json();
    if(!d.success){errEl.textContent=d.message||'로그인 실패';btn.disabled=false;btn.textContent='로그인';return;}
    await boot();
  }catch(e){
    errEl.textContent='네트워크 오류';btn.disabled=false;btn.textContent='로그인';
  }
}

async function doOtpRequest(phone,errEl,btn){
  errEl.textContent='';
  const digits=phone.replace(/[^0-9]/g,'');
  if(digits.length<10){errEl.textContent='휴대폰 번호를 확인해주세요';return;}
  btn.disabled=true;btn.textContent='전송 중...';
  try{
    const res=await fetch('/api/member-auth/otp-request',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:digits})});
    const d=await res.json();
    btn.disabled=false;btn.textContent='인증번호 받기';
    if(!d.success){errEl.textContent=d.message||'전송 실패';return;}
    ST.otpPhone=digits;ST.screen='otp-code';render();
  }catch(e){
    errEl.textContent='네트워크 오류';btn.disabled=false;btn.textContent='인증번호 받기';
  }
}

async function doOtpVerify(code,errEl,btn){
  errEl.textContent='';
  if(!code.trim()){errEl.textContent='인증번호를 입력하세요';return;}
  btn.disabled=true;btn.textContent='확인 중...';
  try{
    const res=await fetch('/api/member-auth/otp-verify',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:ST.otpPhone,code:code.trim()})});
    const d=await res.json();
    btn.disabled=false;btn.textContent='확인';
    if(!d.success){errEl.textContent=d.message||'인증 실패';return;}
    if(d.isNew){ST.screen='otp-name';render();return;}
    ST.mode='member';
    ST.member=await loadMemberMe();
    ST.videos=await loadMemberVideos();
    ST.screen='list';
    render();
  }catch(e){
    errEl.textContent='네트워크 오류';btn.disabled=false;btn.textContent='확인';
  }
}

async function doProfileSave(name,errEl,btn){
  errEl.textContent='';
  if(!name.trim()){errEl.textContent='이름을 입력하세요';return;}
  btn.disabled=true;btn.textContent='저장 중...';
  try{
    const res=await fetch('/api/member-auth/profile',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.trim()})});
    const d=await res.json();
    if(!d.success){errEl.textContent=d.message||'저장 실패';btn.disabled=false;btn.textContent='완료';return;}
    ST.mode='member';
    ST.member=await loadMemberMe();
    ST.videos=await loadMemberVideos();
    ST.screen='list';
    render();
  }catch(e){
    errEl.textContent='네트워크 오류';btn.disabled=false;btn.textContent='완료';
  }
}

async function doLogout(){
  const url=ST.mode==='student'?'/api/auth/logout':'/api/member-auth/logout';
  fetch(url,{method:'POST',credentials:'include'}).catch(()=>{});
  ST.mode=null;ST.student=null;ST.member=null;ST.videos=null;ST.active=null;
  ST.courses=await loadPublicCourses();
  ST.screen='browse';
  render();
}

/* ── 화면 ── */
function topBar(){
  if(['loading','browse','otp-phone','otp-code','otp-name','student-login'].includes(ST.screen))return'';
  const who=ST.mode==='student'
    ?`${esc(ST.student?.student?.name||'')} · ${esc(ST.student?.school?.name||'')}`
    :`${esc(ST.member?.name||'')} · ${esc(ST.member?.phone||'')}`;
  return`<div class="top">
    <div class="brand"><span class="dot"></span>OHENG 인강</div>
    <div style="display:flex;align-items:center;gap:12px">
      <span class="who">${who}</span>
      <button class="btn" id="btn-logout">로그아웃</button>
    </div>
  </div>`;
}

function browseScreen(){
  const courses=ST.courses||[];
  const list=courses.length
    ?courses.map(c=>`<div class="course-card">
        <div class="course-title">${esc(c.title)}</div>
        <div class="course-desc">${esc(c.description||'')}</div>
        <div class="course-meta"><span>영상 ${c.videoCount}개 · 수강기간 ${c.durationDays}일</span><span class="course-price">${won(c.price)}</span></div>
      </div>`).join('')
    :`<div class="empty"><div class="ic">🎬</div><div style="font-size:14px;font-weight:600;color:#C8CFDD;margin-bottom:6px">아직 등록된 강좌가 없습니다</div></div>`;
  return`<div class="intro">
      <div class="intro-title">OHENG 인강</div>
      <div class="intro-sub">휴대폰 번호로 3초 만에 가입하고 바로 학습을 시작하세요</div>
      <button class="btn btn-primary" id="btn-start" style="padding:12px 24px">휴대폰 인증하고 시작하기</button>
      <div class="login-foot"><button class="link-btn" id="btn-student-link">학원 학생이신가요? 학생 로그인</button></div>
    </div>
    ${list}`;
}

function otpPhoneScreen(){
  return`<div class="login-wrap">
    <div class="login-card">
      <div class="login-title">휴대폰 인증</div>
      <div class="login-sub">인증번호를 받을 번호를 입력하세요</div>
      <input class="finp" id="otp-phone" placeholder="01012345678" inputmode="numeric" autocomplete="tel">
      <div class="login-err" id="otp-err"></div>
      <button class="btn btn-primary" id="otp-req-btn" style="width:100%;padding:12px">인증번호 받기</button>
      <div class="login-foot"><button class="link-btn" id="btn-back-browse">‹ 뒤로</button></div>
    </div>
  </div>`;
}

function otpCodeScreen(){
  return`<div class="login-wrap">
    <div class="login-card">
      <div class="login-title">인증번호 입력</div>
      <div class="login-sub">${esc(ST.otpPhone)}로 전송된 6자리 번호를 입력하세요</div>
      <input class="finp" id="otp-code" placeholder="123456" inputmode="numeric" maxlength="6">
      <div class="login-err" id="otp-err"></div>
      <button class="btn btn-primary" id="otp-verify-btn" style="width:100%;padding:12px">확인</button>
      <div class="login-foot"><button class="link-btn" id="btn-resend">인증번호 다시 받기</button></div>
    </div>
  </div>`;
}

function otpNameScreen(){
  return`<div class="login-wrap">
    <div class="login-card">
      <div class="login-title">이름을 알려주세요</div>
      <div class="login-sub">마지막 단계예요</div>
      <input class="finp" id="otp-name" placeholder="이름">
      <div class="login-err" id="otp-err"></div>
      <button class="btn btn-primary" id="otp-name-btn" style="width:100%;padding:12px">완료</button>
    </div>
  </div>`;
}

function loginScreen(){
  return`<div class="login-wrap">
    <div class="login-card">
      <div class="login-title">학생 로그인</div>
      <div class="login-sub">학원에서 발급받은 계정으로 로그인하세요</div>
      <input class="finp" id="lg-id" placeholder="학생 ID" autocomplete="username">
      <input class="finp" id="lg-pw" type="password" placeholder="비밀번호" autocomplete="current-password">
      <div class="login-err" id="lg-err"></div>
      <button class="btn btn-primary" id="lg-btn" style="width:100%;padding:12px">로그인</button>
      <div class="login-foot"><button class="link-btn" id="btn-back-browse">‹ 뒤로</button></div>
    </div>
  </div>`;
}

function videoCard(v){
  return`<div class="vcard" data-vid="${v.id}">
    <div class="vcard-title">🎬 ${esc(v.title)}</div>
  </div>`;
}

function listScreen(){
  const videos=ST.videos||[];
  if(!videos.length){
    const msg=ST.mode==='member'?'아직 구매한 강좌가 없습니다':'아직 볼 수 있는 영상이 없습니다';
    const sub=ST.mode==='member'?'강좌를 구매하면 여기에 표시됩니다':'선생님이 영상을 등록하면 여기에 표시됩니다';
    return`<div class="empty"><div class="ic">🎬</div><div style="font-size:14px;font-weight:600;color:#C8CFDD;margin-bottom:6px">${msg}</div><div style="font-size:12.5px">${sub}</div></div>`;
  }
  if(ST.mode==='member'){
    const groups=[...new Set(videos.map(v=>v.courseTitle))];
    return groups.map(title=>{
      const list=videos.filter(v=>v.courseTitle===title);
      return`<div class="wk-head">${esc(title)} · ${list.length}개</div>${list.map(videoCard).join('')}`;
    }).join('');
  }
  const dated=videos.filter(v=>v.month&&v.week);
  const undated=videos.filter(v=>!(v.month&&v.week));
  const weekKeys=[...new Set(dated.map(v=>v.month+'_'+v.week))]
    .sort((a,b)=>{const[am,aw]=a.split('_'),[bm,bw]=b.split('_');return moI(bm)-moI(am)||wkI(bw)-wkI(aw);});
  const weekSections=weekKeys.map(wk=>{
    const[m,w]=wk.split('_');
    const list=dated.filter(v=>v.month===m&&v.week===w);
    return`<div class="wk-head">${m} ${w} · ${list.length}개</div>${list.map(videoCard).join('')}`;
  }).join('');
  const undatedSection=undated.length?`<div class="wk-head">기타 자료 · ${undated.length}개</div>${undated.map(videoCard).join('')}`:'';
  return weekSections+undatedSection;
}

function playerScreen(){
  const v=ST.active;
  const wk=ST.mode==='member'?(v.courseTitle||'강좌'):(v.month&&v.week?`${v.month} ${v.week}`:'기타 자료');
  return`<button class="player-back" id="btn-back">‹ 목록으로</button>
    <div class="player-title">${esc(v.title)}</div>
    <div class="player-wk">${esc(wk)}</div>
    <div class="player-box">
      <div class="ic">🔒</div>
      <div class="msg">재생 준비 중</div>
      <div class="sub">콜러스(Kollus) 연동 후 이곳에서 바로 재생됩니다</div>
    </div>`;
}

function render(){
  const app=document.getElementById('app');
  if(ST.screen==='loading'){app.innerHTML='<div class="loading">불러오는 중...</div>';return;}
  if(ST.screen==='browse'){app.innerHTML=topBar()+`<main>${browseScreen()}</main>`;wireBrowse();return;}
  if(ST.screen==='otp-phone'){app.innerHTML=topBar()+otpPhoneScreen();wireOtpPhone();return;}
  if(ST.screen==='otp-code'){app.innerHTML=topBar()+otpCodeScreen();wireOtpCode();return;}
  if(ST.screen==='otp-name'){app.innerHTML=topBar()+otpNameScreen();wireOtpName();return;}
  if(ST.screen==='student-login'){app.innerHTML=topBar()+loginScreen();wireStudentLogin();return;}
  const body=ST.screen==='player'?playerScreen():listScreen();
  app.innerHTML=topBar()+`<main>${body}</main>`;
  wireApp();
}

function wireBrowse(){
  document.getElementById('btn-start').addEventListener('click',()=>{ST.screen='otp-phone';render();});
  document.getElementById('btn-student-link').addEventListener('click',()=>{ST.screen='student-login';render();});
}

function wireOtpPhone(){
  const phoneEl=document.getElementById('otp-phone');
  const btn=document.getElementById('otp-req-btn'),err=document.getElementById('otp-err');
  const submit=()=>doOtpRequest(phoneEl.value.trim(),err,btn);
  btn.onclick=submit;
  phoneEl.addEventListener('keydown',e=>{if(e.key==='Enter')submit();});
  document.getElementById('btn-back-browse').addEventListener('click',()=>{ST.screen='browse';render();});
}

function wireOtpCode(){
  const codeEl=document.getElementById('otp-code');
  const btn=document.getElementById('otp-verify-btn'),err=document.getElementById('otp-err');
  const submit=()=>doOtpVerify(codeEl.value.trim(),err,btn);
  btn.onclick=submit;
  codeEl.addEventListener('keydown',e=>{if(e.key==='Enter')submit();});
  document.getElementById('btn-resend').addEventListener('click',()=>{ST.screen='otp-phone';render();});
}

function wireOtpName(){
  const nameEl=document.getElementById('otp-name');
  const btn=document.getElementById('otp-name-btn'),err=document.getElementById('otp-err');
  const submit=()=>doProfileSave(nameEl.value.trim(),err,btn);
  btn.onclick=submit;
  nameEl.addEventListener('keydown',e=>{if(e.key==='Enter')submit();});
}

function wireStudentLogin(){
  const idEl=document.getElementById('lg-id'),pwEl=document.getElementById('lg-pw');
  const btn=document.getElementById('lg-btn'),err=document.getElementById('lg-err');
  const submit=()=>doStudentLogin(idEl.value.trim(),pwEl.value,err,btn);
  btn.onclick=submit;
  pwEl.addEventListener('keydown',e=>{if(e.key==='Enter')submit();});
  document.getElementById('btn-back-browse').addEventListener('click',()=>{ST.screen='browse';render();});
}

function wireApp(){
  document.getElementById('btn-logout')?.addEventListener('click',doLogout);
  document.getElementById('btn-back')?.addEventListener('click',()=>{ST.screen='list';ST.active=null;render();});
  document.querySelectorAll('[data-vid]').forEach(card=>{
    card.addEventListener('click',()=>{
      const v=(ST.videos||[]).find(x=>x.id===card.dataset.vid);
      if(!v)return;
      ST.active=v;ST.screen='player';render();
    });
  });
}

boot();
</script>
</body>
</html>
```

- [ ] **Step 2: HTML/JS 문법 육안 검증**

Run: `cd C:/Users/mikmi/oheng && node -e "new Function(require('fs').readFileSync('lecture.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1]); console.log('OK')"`
Expected: `OK` 출력 (스크립트 블록에 문법 오류 없음)

- [ ] **Step 3: Commit**

```bash
cd C:/Users/mikmi/oheng
git add lecture.html
git commit -m "lecture.html 개편 — 강좌 둘러보기 + 휴대폰 인증 가입/로그인 + 내 강좌(강좌별 그룹) 화면 추가"
```

- [ ] **Step 4: Push (배포 트리거)**

```bash
git push
```

Run: `until curl -s https://oheng.co.kr/api/courses/list | grep -q '"success":true'; do sleep 5; done; echo DEPLOYED`
Expected: 배포 완료 후 `DEPLOYED` 출력

---

### Task 7: 실제 종단 검증 (강좌 생성 → 공개 목록 → 수동 수강권 부여 → 내 강좌 확인) + 정리

**Files:** 없음 (curl + 브라우저 검증만)

**Interfaces:** 없음 (이 계획의 마지막 검증 단계)

- [ ] **Step 1: `oheng.co.kr` 루트가 이제 `lecture.html`을 서빙하는지 확인**

Run: `curl -s https://oheng.co.kr/ | grep -o '<title>[^<]*</title>'`
Expected: `<title>OHENG 인강</title>` (Task 5의 host rewrite 적용 확인)

- [ ] **Step 2: 관리자 API 토큰으로 테스트 강좌 생성**

`.env`에 설정된 `API_AUTH_TOKEN` 값을 `YOUR_API_TOKEN` 자리에 넣어 실행한다:

```bash
curl -s -X POST https://oheng.co.kr/api/courses/save \
  -H "Content-Type: application/json" \
  -H "x-api-token: YOUR_API_TOKEN" \
  -d '{"title":"[테스트] 수학 기초반","description":"테스트용 강좌입니다","price":50000,"durationDays":30,"videoIds":[],"published":true}'
```

Expected: `{"success":true,"course":{"id":"crs...","title":"[테스트] 수학 기초반",...}}` — 이 `id`를 `TEST_COURSE_ID`로 기록해둔다.

- [ ] **Step 3: 공개 목록에 노출되는지 확인 (비로그인)**

Run: `curl -s https://oheng.co.kr/api/courses/list`
Expected: 응답의 `courses` 배열에 `TEST_COURSE_ID`가 `price:50000`, `videoCount:0`으로 포함됨

- [ ] **Step 4: 회원 OTP 로그인 (Phase 1 흐름 재사용)**

Phase 1 계획서(`docs/superpowers/plans/2026-07-21-member-otp-auth.md`)의 Task 6과 동일한 절차로 본인 휴대폰 번호로 로그인해 쿠키를 저장한다:

```bash
curl -s -X POST https://oheng.co.kr/api/member-auth/otp-request \
  -H "Content-Type: application/json" -d '{"phone":"YOUR_PHONE"}'
# 문자로 받은 코드로:
curl -s -c /tmp/oheng_member_cookie.txt -X POST https://oheng.co.kr/api/member-auth/otp-verify \
  -H "Content-Type: application/json" -d '{"phone":"YOUR_PHONE","code":"RECEIVED_CODE"}'
curl -s -b /tmp/oheng_member_cookie.txt https://oheng.co.kr/api/member-auth/me
```

Expected: 마지막 호출에서 `{"success":true,"member":{"id":"mem...",...}}` — 이 `id`를 `TEST_MEMBER_ID`로 기록해둔다.

- [ ] **Step 5: 로그인 전 `mine` 조회는 빈 배열인지 확인**

Run: `curl -s -b /tmp/oheng_member_cookie.txt https://oheng.co.kr/api/courses/mine`
Expected: `{"success":true,"videos":[]}` (아직 아무 강좌도 부여받지 않음)

- [ ] **Step 6: 관리자가 수동으로 수강권 부여**

```bash
curl -s -X POST https://oheng.co.kr/api/courses/grant-entitlement \
  -H "Content-Type: application/json" \
  -H "x-api-token: YOUR_API_TOKEN" \
  -d '{"memberId":"TEST_MEMBER_ID","courseId":"TEST_COURSE_ID","days":30}'
```

Expected: `{"success":true,"member":{...,"entitlements":[{"courseId":"TEST_COURSE_ID","status":"active",...}]}}`

- [ ] **Step 7: 부여 후 `mine` 조회 확인**

(`TEST_COURSE_ID`의 `videoIds`가 비어 있으므로 영상은 안 보이는 게 정상. 영상 노출까지 보려면 관리자 API 토큰으로 `/api/videos/list`에서 기존 영상 id 하나를 확인해 Step 2의 `videoIds`에 넣고 Step 2~7을 다시 실행한다.)

Run: `curl -s -b /tmp/oheng_member_cookie.txt https://oheng.co.kr/api/courses/mine`
Expected: `videoIds`에 실제 영상을 넣어 재실행한 경우 `videos` 배열에 `courseTitle:"[테스트] 수학 기초반"`인 항목이 나타남

- [ ] **Step 8: 브라우저로 강좌 둘러보기 → 로그인 → 내 강좌 화면 확인**

`https://oheng.co.kr/` 접속 → "OHENG 인강" 인트로 + 강좌 카드(`[테스트] 수학 기초반`, 50,000원) 노출 확인 → "휴대폰 인증하고 시작하기" 클릭 → 이미 Step 4에서 인증한 번호로 재로그인 시도 시 인증번호 재요청 후 바로 "내 강좌" 화면으로 진입해 강좌별로 그룹된 영상 목록(또는 빈 상태 문구)이 보이는지 확인. "학원 학생이신가요?" 링크 클릭 시 기존 학생 로그인 화면으로 전환되는지도 확인.

- [ ] **Step 9: 회수(revoke) 동작 확인**

```bash
curl -s -X POST https://oheng.co.kr/api/courses/revoke-entitlement \
  -H "Content-Type: application/json" \
  -H "x-api-token: YOUR_API_TOKEN" \
  -d '{"memberId":"TEST_MEMBER_ID","courseId":"TEST_COURSE_ID"}'
curl -s -b /tmp/oheng_member_cookie.txt https://oheng.co.kr/api/courses/mine
```

Expected: revoke 호출은 `{"success":true,...}`, 이후 `mine` 조회는 다시 `{"success":true,"videos":[]}`

- [ ] **Step 10: 테스트 데이터 정리**

```bash
curl -s -X POST https://oheng.co.kr/api/courses/delete \
  -H "Content-Type: application/json" \
  -H "x-api-token: YOUR_API_TOKEN" \
  -d '{"id":"TEST_COURSE_ID"}'
```

Expected: `{"success":true}`. Phase 1 때와 마찬가지로 테스트 회원(`member:TEST_MEMBER_ID`, `member:phone:YOUR_PHONE`) 데이터는 실서비스 오픈 전까지 남겨둬도 무방하다.

- [ ] **Step 11: 최종 커밋 로그 확인**

Run: `cd C:/Users/mikmi/oheng && git log --oneline -7`
Expected: Task 1~6의 커밋 6개가 순서대로 보임
