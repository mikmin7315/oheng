# 인강 재정비 A — 워터마크·네비·성적표 왕복·자동 시청기록·내 강의실·현황·출석 제안 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인강 재정비 설계의 1~6단계를 구현한다 — 워터마크 축소와 로그인 네비, 성적표↔인강 왕복, 재생기가 실제 재생 구간을 서버에 자동 기록(90% 완료), 학생 "내 강의실"·성적표 시청률·관리자 영상별 현황, 인강/현강 체크의 완료 제안. 7단계(게시판형 후기)는 별도 계획 B.

**Architecture:** 시청 기록은 기존 `watch:{ownerType}:{ownerId}:{videoId}` 레코드에 `progress` 필드를 더한다. 서버(`api/_lib/watch.js`)가 구간을 병합·재계산하고 90% 이상이면 `auto_completed`로 올리되 선생님 정정(`source:'teacher'`)은 절대 덮지 않는다. 라우터 `api/videos/[action].js`는 인증만 하고 시청 관련 액션을 새 `api/_lib/watch-actions.js`에 위임한다(함수 파일 12개 유지). 재생기(`lecture.html`)는 실제 재생한 구간만 모아 15초마다·이탈 시 보낸다. 화면은 모두 "재생 기준 N%"로 표기한다.

**Tech Stack:** Vercel Serverless(Node ESM), Upstash Redis, 단일 파일 바닐라 JS(`lecture.html`, `index.html`), `node:test`.

**Spec:** [docs/superpowers/specs/2026-09-12-lecture-replan-design.md](../specs/2026-09-12-lecture-replan-design.md)

## Global Constraints

- **새 `api/*.js` 파일 금지**(Vercel Hobby 함수 12개, 이미 꽉 참). `api/_lib/*`는 자유. 작업 후 `find api -name "*.js" -not -path "*/_lib/*" | wc -l` = 12.
- 자동 기록은 "재생 완료"/"N% 시청"으로만 표기. "수강 완료"·"봤음" 금지. 선생님 정정값이 항상 자동값 위에 표시. `fast_progress`는 선생님 화면에만 "확인 필요".
- 선생님 정정(`source:'teacher'`)은 자동 기록이 status/source/setBy를 절대 바꾸지 않는다. 반대로 정정은 `progress`를 보존한다.
- 완료 기준 `ratio >= 0.9`. 구간은 초 단위 정수, `0 ≤ s < e ≤ durationSec`, `durationSec` 1~21600, 구간 개수 ≤ 400. 증가 속도: 이전 저장 후 경과초 × 2.5 + 30 을 넘으면 `fast_progress` 플래그(저장은 함).
- `watch-progress`는 `listVisibleVideosForOwner`에 있는 영상만 허용(없으면 404 `볼 수 없는 영상입니다`), 분당 60회 제한.
- 성적표↔인강 이동은 **상대 경로**(`/lecture.html`, `/index.html`) — 도메인을 바꾸면 재로그인 필요.
- `index.html` 새 요소는 반드시 글자색 지정(다크모드에서 흐려짐).
- 테스트 `npm test`(= `node --experimental-test-module-mocks --test tests/*.test.mjs`); 가짜 Redis `get()`은 깊은 복제. 기존 77개 테스트 유지.
- 커밋은 `main` 직접, 메시지 끝 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 화면 파일은 줄 번호가 흔들리므로 계획의 줄 번호는 참고용, **보여준 기존 코드 조각으로 찾아** 고친다. 두 HTML은 각각 `node -e "...new Function..."`(아래 명령)로 문법 검사.

문법 검사 명령(두 파일 공통, `FILE`만 바꿈):
```bash
node -e "const fs=require('fs');const html=fs.readFileSync('FILE','utf8');const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);blocks.forEach(b=>new Function(b));console.log('OK: '+blocks.length+' inline script block(s) parse')"
```
Expected: `lecture.html` → 1 block, `index.html` → 2 blocks.

---

## File Structure

**Create**
- `api/_lib/watch-actions.js` — 시청 관련 HTTP 액션 처리(라우터에서 위임)
- `tests/watch-progress.test.mjs` — `watch.js` 구간 병합·완료·정정 우선 규칙
- `tests/watch-actions.test.mjs` — `watch-progress`·`watch-admin-week`·`watch-mine` progress 포함

**Modify**
- `api/_lib/watch.js` — `mergeSegments`, `sumSegments`, `recordProgress`, `teacherSetWatchStatus` progress 보존
- `api/videos/[action].js` — 시청 액션 위임
- `lecture.html` — 워터마크, 네비, 자동 기록 재생기, 내 강의실
- `index.html` — 학생 '인강' 탭, 성적표 시청률, 영상별 현황, 출석 제안

---

### Task 1: 워터마크 모서리 축소 + 로그인 네비(내 강의실·강좌·후기) — 1단계

**Files:** Modify `lecture.html`

**Interfaces:**
- Produces: 네비 버튼 `data-nav="list|browse|reviews"`와 `#app` 위임 클릭 처리(`wireNavDelegation()`), 이후 Task 2가 `data-nav="report"`를 같은 처리기에 추가.

- [ ] **Step 1: 워터마크 CSS**

기존 줄(`.vp-mark{position:absolute;top:10%;left:6%;...}`)을 통째로 교체:
```css
  .vp-mark{position:absolute;z-index:2;color:#fff;opacity:.3;font-size:11px;font-weight:700;white-space:nowrap;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.7);transition:opacity .6s ease}
```
기존 모바일 규칙 `@media (max-width:480px){ .vp-bar{gap:6px;padding:8px} #vp-mute{display:none} .vp-mark{font-size:12px} }` 안의 `.vp-mark{font-size:12px}`를 `.vp-mark{font-size:10px}`로. 그리고 그 줄 바로 아래에 추가:
```css
  @media (max-width:480px){ .who{display:none} }
```

- [ ] **Step 2: 모서리 이동 로직**

`wirePlayer` 안의 기존 세 줄:
```js
  const moveMark=()=>{mark.style.top=(5+Math.random()*75)+'%';mark.style.left=(3+Math.random()*55)+'%';};
  moveMark();
  ST.vpMarkTimer=setInterval(moveMark,30000);
```
교체(아래쪽 모서리는 컨트롤 막대 위에 오도록 14% 띄움):
```js
  // 네 모서리만 돌아가며 표시 — 가운데로 튀지 않아 덜 거슬리고, 녹화본 테두리를 잘라내도 어느 한
  // 모서리는 남는다. 아래쪽은 컨트롤 막대에 가리지 않게 14% 띄운다.
  const CORNERS=[{top:'4%',left:'4%'},{top:'4%',right:'4%'},{bottom:'14%',left:'4%'},{bottom:'14%',right:'4%'}];
  let cornerIdx=Math.floor(Math.random()*CORNERS.length);
  const moveMark=()=>{
    const c=CORNERS[cornerIdx];
    cornerIdx=(cornerIdx+1+Math.floor(Math.random()*(CORNERS.length-1)))%CORNERS.length;
    mark.style.opacity='0';
    setTimeout(()=>{
      mark.style.top=c.top||'auto';mark.style.bottom=c.bottom||'auto';
      mark.style.left=c.left||'auto';mark.style.right=c.right||'auto';
      mark.style.opacity='';
    },600);
  };
  const c0=CORNERS[cornerIdx];
  mark.style.top=c0.top||'auto';mark.style.bottom=c0.bottom||'auto';mark.style.left=c0.left||'auto';mark.style.right=c0.right||'auto';
  ST.vpMarkTimer=setInterval(moveMark,30000);
```

- [ ] **Step 3: 네비 — 로그인 시 링크 세 개**

`navBar()`의 기존 줄:
```js
    ?`<button class="nav-textlink" id="nav-browse-courses">강좌 더보기</button><span class="who">${ST.mode==='student'?`${esc(ST.student?.student?.name||'')} · ${esc(ST.student?.school?.name||'')}`:`${esc(ST.member?.name||'')} · ${esc(ST.member?.phone||ST.member?.email||'')}`}</span><button class="btn" id="btn-logout">로그아웃</button>`
```
교체:
```js
    ?`${navLink('list','내 강의실',ST.screen==='list'||ST.screen==='player')}${navLink('browse','강좌',ST.screen==='browse')}${navLink('reviews','후기',ST.screen==='reviews')}<span class="who">${ST.mode==='student'?`${esc(ST.student?.student?.name||'')} · ${esc(ST.student?.school?.name||'')}`:`${esc(ST.member?.name||'')} · ${esc(ST.member?.phone||ST.member?.email||'')}`}</span><button class="btn" id="btn-logout">로그아웃</button>`
```
`function navBar(){` 바로 위에 추가:
```js
// 로그인 상태의 상단 링크. 화면이 통째로 다시 그려져도 동작하도록 클릭은 #app에서 위임 처리(wireNavDelegation).
function navLink(nav,label,active){
  return`<button class="nav-textlink" data-nav="${nav}" style="${active?'color:var(--coral);font-weight:800':''}">${label}</button>`;
}
```

- [ ] **Step 4: 위임 클릭 처리 + 옛 버튼 처리기 제거**

파일 맨 아래 `boot();` 줄 **바로 위**에 추가:
```js
// 상단 링크는 모든 화면에 뜨므로, 화면별 wire 함수마다 붙이지 않고 #app에서 한 번만 위임 처리한다.
function wireNavDelegation(){
  document.getElementById('app').addEventListener('click',async e=>{
    const t=e.target.closest('[data-nav]');
    if(!t)return;
    const nav=t.dataset.nav;
    if(nav==='list'){ST.videos=ST.mode==='member'?await loadMemberVideos():await loadStudentVideos();ST.active=null;ST.screen='list';render();}
    else if(nav==='browse'){ST.courses=await loadPublicCourses();ST.screen='browse';render();}
    else if(nav==='reviews'){ST.reviews=await loadReviews();ST.screen='reviews';render();}
  });
}
wireNavDelegation();
```
아래 세 곳의 옛 처리기 줄을 **삭제**:
```js
  document.getElementById('nav-browse-courses')?.addEventListener('click',async()=>{ST.courses=await loadPublicCourses();ST.screen='browse';render();});
```
```js
  document.getElementById('nav-browse-courses')?.addEventListener('click',()=>{window.scrollTo({top:0,behavior:'smooth'});});
```
```js
  document.getElementById('nav-browse-courses')?.addEventListener('click',async()=>{
    ST.courses=await loadPublicCourses();ST.screen='browse';render();
  });
```
(`wireBrowse` 안의 주석 "nav-browse-courses/btn-logout이 떠있으므로…"는 "btn-logout이 떠있으므로…"로 고친다.)

- [ ] **Step 5: 문법 검사 + 커밋**

문법 검사(lecture.html → `OK: 1 inline script block(s) parse`), `npm test` 77/77.
```bash
git add lecture.html
git commit -m "$(cat <<'EOF'
워터마크를 모서리에만 작게 표시, 로그인 후 상단에 내 강의실·강좌·후기 링크 상시 노출

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 성적표 ↔ 인강 왕복 — 2단계

**Files:** Modify `index.html`, `lecture.html`

**Interfaces:**
- Consumes: Task 1의 `navLink`, `wireNavDelegation`.

- [ ] **Step 1: 성적표 학생 탭에 '인강'**

`rStudent()`의 기존 탭 배열에서 `{id:'mock',l:'모의고사'...},` 줄 **바로 다음**에 추가:
```js
    {id:'lecture',l:'🎬 인강'},
```
`bStudent()`의 기존 줄:
```js
  document.querySelectorAll('.tab[data-tab]').forEach(t=>{t.onclick=()=>{ST.tab=t.dataset.tab;render()}});
```
교체(같은 주소 안 인강 화면으로 — 도메인이 같아 로그인 유지):
```js
  document.querySelectorAll('.tab[data-tab]').forEach(t=>{t.onclick=()=>{
    if(t.dataset.tab==='lecture'){location.href='/lecture.html';return;}
    ST.tab=t.dataset.tab;render();
  }});
```

- [ ] **Step 2: 인강 네비에 '성적표'**

`lecture.html` `navBar()`에서 Task 1이 넣은 `${navLink('reviews','후기',ST.screen==='reviews')}` 바로 뒤에 추가:
```js
${ST.mode==='student'?navLink('report','성적표',false):''}
```
`wireNavDelegation` 안 `else if(nav==='reviews'){...}` 줄 다음에 추가:
```js
    else if(nav==='report'){location.href='/index.html';}
```

- [ ] **Step 3: 확인 + 커밋**

두 파일 문법 검사, `npm test` 77/77. 브라우저(컨트롤러): 학생 로그인 → 성적표 '인강' 탭 → 영상 목록이 **로그인 유지된 채** 뜨는지, 인강 '성적표' 링크로 되돌아오는지, 주소창 도메인이 바뀌지 않는지.
```bash
git add index.html lecture.html
git commit -m "$(cat <<'EOF'
성적표 '인강' 탭과 인강 '성적표' 링크로 같은 주소 안에서 왕복

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 시청 구간 저장 규칙 (`watch.js`) — 3단계 ①

**Files:** Modify `api/_lib/watch.js`; Test `tests/watch-progress.test.mjs`(신규)

**Interfaces:**
- Produces:
  - `mergeSegments(segments, durationSec) → [[s,e],...]` (정렬·클램프·겹침 병합, 잘못된 항목 무시)
  - `sumSegments(segments) → number`
  - `recordProgress(ownerType, ownerId, videoId, {durationSec, segments, lastPositionSec}, now?) → record` — 실패 시 `err.code==='BAD_INPUT'`
  - `WATCH_COMPLETE_RATIO = 0.9`
  - record에 `progress: {durationSec, segments, watchedSec, ratio, lastPositionSec, flags, firstAt, updatedAt}`; status `'auto_completed'`, source `'player'`
  - `teacherSetWatchStatus`가 `progress`를 보존

- [ ] **Step 1: 실패하는 테스트**

`tests/watch-progress.test.mjs`:
```js
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) { const existed = store.has(key); store.delete(key); return existed ? 1 : 0; },
  };
}
const fakeRedis = makeFakeRedis();
before(() => { mock.module('../api/_lib/redis.js', { namedExports: { getRedis: () => fakeRedis } }); });
const watch = await import('../api/_lib/watch.js');

test('mergeSegments: 정렬·겹침 병합·범위 밖 잘라내기·잘못된 항목 무시', () => {
  const merged = watch.mergeSegments([[30, 45], [0, 10], [8, 20], [-5, 3], [590, 700], ['x', 5], [50, 50]], 600);
  assert.deepEqual(merged, [[0, 20], [30, 45], [590, 600]]);
  assert.equal(watch.sumSegments(merged), 20 + 15 + 10);
});

test('recordProgress: 구간을 누적 병합하고 시청 시간은 서버가 다시 계산한다', async () => {
  const t0 = Date.parse('2026-09-12T10:00:00Z');
  const r1 = await watch.recordProgress('student', 'sch:stu', 'v1', { durationSec: 100, segments: [[0, 30]], lastPositionSec: 30, watchedSec: 999 }, t0);
  assert.equal(r1.progress.watchedSec, 30);
  assert.equal(r1.progress.ratio, 0.3);
  assert.equal(r1.status, 'opened');
  assert.equal(r1.progress.lastPositionSec, 30);
  const r2 = await watch.recordProgress('student', 'sch:stu', 'v1', { durationSec: 100, segments: [[20, 50]], lastPositionSec: 50 }, t0 + 25000);
  assert.deepEqual(r2.progress.segments, [[0, 50]]);
  assert.equal(r2.progress.watchedSec, 50);
  assert.equal(r2.progress.firstAt, r1.progress.firstAt);
});

test('recordProgress: 90% 이상이면 auto_completed/player, 미만이면 유지', async () => {
  const t0 = Date.parse('2026-09-12T11:00:00Z');
  const a = await watch.recordProgress('student', 'sch:stu', 'v2', { durationSec: 100, segments: [[0, 89]] }, t0);
  assert.equal(a.status, 'opened');
  const b = await watch.recordProgress('student', 'sch:stu', 'v2', { durationSec: 100, segments: [[89, 90]] }, t0 + 5000);
  assert.equal(b.status, 'auto_completed');
  assert.equal(b.source, 'player');
  assert.ok(b.completedAt);
});

test('recordProgress: 건너뛴 구간은 세지 않는다 (끝으로 점프해도 완료 아님)', async () => {
  const r = await watch.recordProgress('student', 'sch:stu', 'v3', { durationSec: 600, segments: [[0, 10], [590, 600]] }, Date.now());
  assert.equal(r.progress.watchedSec, 20);
  assert.equal(r.status, 'opened');
});

test('recordProgress: 선생님 정정 이후의 자동 기록은 status/source를 바꾸지 않는다', async () => {
  await watch.teacherSetWatchStatus('student', 'sch:stu', 'v4', 'exempt', '오은실');
  const r = await watch.recordProgress('student', 'sch:stu', 'v4', { durationSec: 100, segments: [[0, 100]] }, Date.now());
  assert.equal(r.status, 'exempt');
  assert.equal(r.source, 'teacher');
  assert.equal(r.setBy, '오은실');
  assert.equal(r.progress.ratio, 1);
});

test('teacherSetWatchStatus: 기존 progress를 지우지 않는다', async () => {
  await watch.recordProgress('student', 'sch:stu', 'v5', { durationSec: 100, segments: [[0, 40]] }, Date.now());
  const r = await watch.teacherSetWatchStatus('student', 'sch:stu', 'v5', 'teacher_confirmed', '오은실');
  assert.equal(r.status, 'teacher_confirmed');
  assert.equal(r.progress.watchedSec, 40);
});

test('recordProgress: 너무 빠른 증가는 fast_progress 플래그 (저장은 함)', async () => {
  const t0 = Date.parse('2026-09-12T12:00:00Z');
  await watch.recordProgress('student', 'sch:stu', 'v6', { durationSec: 3600, segments: [[0, 10]] }, t0);
  const r = await watch.recordProgress('student', 'sch:stu', 'v6', { durationSec: 3600, segments: [[10, 2000]] }, t0 + 10000);
  assert.ok(r.progress.flags.includes('fast_progress'));
  assert.equal(r.progress.watchedSec, 2000);
  const ok = await watch.recordProgress('student', 'sch:stu', 'v7', { durationSec: 3600, segments: [[0, 10]] }, t0);
  const ok2 = await watch.recordProgress('student', 'sch:stu', 'v7', { durationSec: 3600, segments: [[10, 40]] }, t0 + 15000);
  assert.deepEqual(ok2.progress.flags, []);
  void ok;
});

test('recordProgress: 잘못된 길이·구간은 BAD_INPUT', async () => {
  for (const bad of [
    { durationSec: 0, segments: [[0, 1]] },
    { durationSec: 99999, segments: [[0, 1]] },
    { durationSec: 100, segments: 'nope' },
    { durationSec: 100, segments: Array.from({ length: 401 }, (_, i) => [i, i + 1]) },
  ]) {
    await assert.rejects(() => watch.recordProgress('student', 'sch:stu', 'v8', bad), e => e.code === 'BAD_INPUT');
  }
});
```

- [ ] **Step 2: 실패 확인** — `node --experimental-test-module-mocks --test tests/watch-progress.test.mjs` → FAIL(`mergeSegments is not a function` 등).

- [ ] **Step 3: 구현**

`api/_lib/watch.js`의 `watchKey` 함수 **위**(import 다음)에 추가:
```js
// 자동 시청 기록. 재생기가 보낸 "실제 재생한 구간"을 서버가 병합·재계산한다 — 클라이언트가 보낸
// 합계는 믿지 않는다. 90% 이상이면 auto_completed. 선생님이 정정한 값(source:'teacher')은 절대 덮지
// 않는다(Codex 검토 반영). 이 기록은 "재생기 기준"일 뿐 실제로 보고 들었다는 증명이 아니다.
export const WATCH_COMPLETE_RATIO = 0.9;
const MAX_DURATION_SEC = 21600;
const MAX_SEGMENTS = 400;

export function mergeSegments(segments, durationSec) {
  const clean = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!Array.isArray(seg) || seg.length !== 2) continue;
    let s = Math.floor(Number(seg[0]));
    let e = Math.ceil(Number(seg[1]));
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    s = Math.max(0, s);
    e = Math.min(durationSec, e);
    if (e > s) clean.push([s, e]);
  }
  clean.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of clean) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

export function sumSegments(segments) {
  return (segments || []).reduce((acc, [s, e]) => acc + (e - s), 0);
}

function badInput(message) {
  const err = new Error(message);
  err.code = 'BAD_INPUT';
  return err;
}

export async function recordProgress(ownerType, ownerId, videoId, input, now = Date.now()) {
  const durationSec = Math.floor(Number(input?.durationSec));
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_DURATION_SEC) throw badInput('영상 길이가 올바르지 않습니다');
  const incoming = input?.segments;
  if (!Array.isArray(incoming) || incoming.length > MAX_SEGMENTS) throw badInput('재생 구간이 올바르지 않습니다');

  const redis = getRedis();
  const key = watchKey(ownerType, ownerId, videoId);
  const existing = await redis.get(key);
  const prev = existing?.progress || null;
  const segments = mergeSegments([...(prev?.segments || []), ...incoming], durationSec).slice(0, MAX_SEGMENTS);
  const watchedSec = sumSegments(segments);
  const ratio = Math.min(1, Math.round((watchedSec / durationSec) * 100) / 100);

  // 증가 속도 검사 — 2배속 재생 + 시계 오차를 넘는 증가는 의심 표시만 하고 저장은 한다(정상 기록을 잃지 않게).
  const flags = new Set(prev?.flags || []);
  if (prev) {
    const elapsedSec = Math.max(0, (now - Date.parse(prev.updatedAt)) / 1000);
    if (watchedSec - (prev.watchedSec || 0) > elapsedSec * 2.5 + 30) flags.add('fast_progress');
  }

  const nowIso = new Date(now).toISOString();
  const lastPositionSec = Math.min(durationSec, Math.max(0, Math.floor(Number(input?.lastPositionSec)) || 0));
  const progress = { durationSec, segments, watchedSec, ratio, lastPositionSec, flags: [...flags], firstAt: prev?.firstAt || nowIso, updatedAt: nowIso };

  const teacherSet = existing?.source === 'teacher';
  const completed = ratio >= WATCH_COMPLETE_RATIO;
  const record = {
    ownerType, ownerId, videoId,
    status: teacherSet ? existing.status : (completed ? 'auto_completed' : (existing?.status || 'opened')),
    source: teacherSet ? 'teacher' : (completed ? 'player' : (existing?.source || 'player')),
    firstOpenedAt: existing?.firstOpenedAt || nowIso,
    completedAt: teacherSet ? (existing.completedAt || null)
      : (completed ? (existing?.status === 'auto_completed' ? existing.completedAt : nowIso) : (existing?.completedAt || null)),
    updatedAt: nowIso,
    history: existing?.history || [],
    ...(existing?.setBy ? { setBy: existing.setBy } : {}),
    progress,
  };
  await redis.set(key, record);
  return record;
}
```
`teacherSetWatchStatus`의 레코드 객체에서 `setBy: teacherName,` 줄 **다음**에 추가:
```js
    progress: existing?.progress || null,
```
파일 맨 위 주석의 `status: 'opened' | 'self_confirmed' | 'teacher_confirmed' | 'exempt'` 줄을 `status: 'opened' | 'self_confirmed'(옛 자기확인, 더 이상 생성 안 함) | 'auto_completed' | 'teacher_confirmed' | 'exempt'`로, `source: 'student' | 'teacher'`를 `source: 'student' | 'player' | 'teacher'`로 고친다.

- [ ] **Step 4: 통과 확인** — 위 테스트 8개 PASS, `npm test` 85/85(77+8).

- [ ] **Step 5: 커밋**
```bash
git add api/_lib/watch.js tests/watch-progress.test.mjs
git commit -m "$(cat <<'EOF'
시청 구간 자동 기록 규칙 추가 (서버 병합·90% 완료·선생님 정정 우선·빠른 진행 표시)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 시청 액션 위임 + `watch-progress`·`watch-admin-week` — 3단계 ②

**Files:** Create `api/_lib/watch-actions.js`; Modify `api/videos/[action].js`; Test `tests/watch-actions.test.mjs`(신규)

**Interfaces:**
- Consumes: Task 3 `recordProgress`; 기존 `listWatchStatuses`, `selfConfirmWatch`, `teacherSetWatchStatus`(watch.js), `listVisibleVideosForOwner`(playback.js), `listAllVideos`, `canStudentAccessVideo`(video.js), `getSchool`(school.js), `makeStudentOwnerId`(entitlements.js), `isSameOrigin`, `checkRateLimit`(auth.js)
- Produces:
  - `OWNER_WATCH_ACTIONS = ['watch-mine','watch-confirm','watch-progress']`, `ADMIN_WATCH_ACTIONS = ['watch-admin-list','watch-admin-set','watch-admin-week']`
  - `handleOwnerWatchAction(action, req, res, owner)`, `handleAdminWatchAction(action, req, res, admin)` — 응답까지 처리
  - HTTP `POST /api/videos/watch-progress` body `{videoId, durationSec, segments:[[s,e]], lastPositionSec}` → `{success, record}` / 400 / 401 / 404 `볼 수 없는 영상입니다` / 429
  - HTTP `GET /api/videos/watch-admin-week?schoolId&month[&week]` (관리자) → `{success, weeks:{ [week]: { videos:[{id,title}], students:{ [studentId]: {completed, total, best:{videoId, ratio, status, flags}|null} } } }}`
  - `watch-mine`/`watch-admin-list` 응답 레코드에 `progress` 포함(레코드 그대로 반환하므로 자동)

- [ ] **Step 1: 실패하는 테스트**

`tests/watch-actions.test.mjs`:
```js
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) { const existed = store.has(key); store.delete(key); return existed ? 1 : 0; },
    async incr(key) { const v = (store.get(key) || 0) + 1; store.set(key, v); return v; },
    async expire() { return 1; },
  };
}
function makeRes() {
  const res = { statusCode: 200, body: undefined, headers: {},
    status(c) { res.statusCode = c; return res; }, json(o) { res.body = o; return res; }, end() { return res; }, setHeader(k, v) { res.headers[k] = v; } };
  return res;
}
const fakeRedis = makeFakeRedis();
process.env.API_AUTH_TOKEN = 'test-admin-token';
before(() => {
  mock.module('../api/_lib/redis.js', { namedExports: { getRedis: () => fakeRedis } });
  mock.module('../api/_lib/dropbox.js', { namedExports: {
    getTemporaryLink: async () => 'https://dl.dropboxusercontent.com/x', listVideoFolder: async () => ({ files: [], folderMissing: false }),
    uploadReviewImage: async () => '', REVIEW_IMAGE_LIMITS: { MAX_IMAGE_BYTES: 0, MAX_IMAGES_PER_REVIEW: 0 } } });
});
const auth = await import('../api/_lib/auth.js');
const video = await import('../api/_lib/video.js');
const handler = (await import('../api/videos/[action].js')).default;

const SCHOOL = 'sch_wa';
async function seedSchool() {
  await fakeRedis.set('school:' + SCHOOL, { id: SCHOOL, name: '시청테스트고', version: 0,
    students: [{ id: 'stu_a', name: '가나다', entitlements: [] }, { id: 'stu_b', name: '라마바', entitlements: [] }], withdrawnStudents: [] });
}
async function studentCookie(sid) { const { token } = await auth.createSession({ role: 'student', schoolId: SCHOOL, studentId: sid }); return `oheng_session=${token}`; }
const ADMIN = { 'x-api-token': 'test-admin-token' };

test('watch-progress: 비로그인 401, 안 보이는 영상 404, 잘못된 입력 400, 정상 200 + progress', async () => {
  await seedSchool();
  await video.saveVideo({ id: 'wv1', title: '1주 해설', month: '9월', week: '1주', dropboxPath: '/videos/a.mp4', allowSchoolIds: [SCHOOL] });
  await video.saveVideo({ id: 'wv-other', title: '남의 영상', dropboxPath: '/videos/b.mp4', allowSchoolIds: ['other'] });
  const cookie = await studentCookie('stu_a');
  const good = { videoId: 'wv1', durationSec: 100, segments: [[0, 95]], lastPositionSec: 95 };

  const anon = makeRes();
  await handler({ method: 'POST', headers: {}, body: good, query: { action: 'watch-progress' } }, anon);
  assert.equal(anon.statusCode, 401);

  const hidden = makeRes();
  await handler({ method: 'POST', headers: { cookie }, body: { ...good, videoId: 'wv-other' }, query: { action: 'watch-progress' } }, hidden);
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.body.message, '볼 수 없는 영상입니다');

  const bad = makeRes();
  await handler({ method: 'POST', headers: { cookie }, body: { ...good, durationSec: 0 }, query: { action: 'watch-progress' } }, bad);
  assert.equal(bad.statusCode, 400);

  const ok = makeRes();
  await handler({ method: 'POST', headers: { cookie }, body: good, query: { action: 'watch-progress' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.record.status, 'auto_completed');
  assert.equal(ok.body.record.progress.ratio, 0.95);

  const mine = makeRes();
  await handler({ method: 'GET', headers: { cookie }, query: { action: 'watch-mine', videoIds: 'wv1' } }, mine);
  assert.equal(mine.body.statuses.wv1.progress.watchedSec, 95);
});

test('watch-admin-week: 주차별로 학생×영상 완료 수를 집계하고, 학생 예외로 차단된 영상은 세지 않는다', async () => {
  await seedSchool();
  await video.saveVideo({ id: 'wk1', title: '9월 2주 A', month: '9월', week: '2주', dropboxPath: '/videos/c.mp4', allowSchoolIds: [SCHOOL] });
  await video.saveVideo({ id: 'wk2', title: '9월 2주 B', month: '9월', week: '2주', dropboxPath: '/videos/d.mp4', allowSchoolIds: [SCHOOL], excludeStudentIds: ['stu_b'] });
  const cookieA = await studentCookie('stu_a');
  await handler({ method: 'POST', headers: { cookie: cookieA }, body: { videoId: 'wk1', durationSec: 100, segments: [[0, 100]] }, query: { action: 'watch-progress' } }, makeRes());
  await handler({ method: 'POST', headers: { cookie: cookieA }, body: { videoId: 'wk2', durationSec: 100, segments: [[0, 30]] }, query: { action: 'watch-progress' } }, makeRes());

  const anon = makeRes();
  await handler({ method: 'GET', headers: {}, query: { action: 'watch-admin-week', schoolId: SCHOOL, month: '9월' } }, anon);
  assert.equal(anon.statusCode, 401);

  const res = makeRes();
  await handler({ method: 'GET', headers: ADMIN, query: { action: 'watch-admin-week', schoolId: SCHOOL, month: '9월', week: '2주' } }, res);
  assert.equal(res.statusCode, 200);
  const w = res.body.weeks['2주'];
  assert.deepEqual(w.videos.map(v => v.id).sort(), ['wk1', 'wk2']);
  assert.equal(w.students.stu_a.completed, 1);
  assert.equal(w.students.stu_a.total, 2);
  assert.equal(w.students.stu_a.best.videoId, 'wk1');
  assert.equal(w.students.stu_b.total, 1, '예외로 차단된 wk2는 stu_b에게 세지 않음');
  assert.equal(w.students.stu_b.completed, 0);
  assert.equal(w.students.stu_b.best, null);

  const all = makeRes();
  await handler({ method: 'GET', headers: ADMIN, query: { action: 'watch-admin-week', schoolId: SCHOOL, month: '9월' } }, all);
  assert.ok(all.body.weeks['1주'] && all.body.weeks['2주'], 'week 생략 시 그 달의 모든 주차');
});
```

- [ ] **Step 2: 실패 확인** — `node --experimental-test-module-mocks --test tests/watch-actions.test.mjs` → FAIL(404 Not found 등).

- [ ] **Step 3: `api/_lib/watch-actions.js` 작성**
```js
import { isSameOrigin, checkRateLimit } from './auth.js';
import { listWatchStatuses, selfConfirmWatch, teacherSetWatchStatus, recordProgress, WATCH_COMPLETE_RATIO } from './watch.js';
import { listVisibleVideosForOwner } from './playback.js';
import { listAllVideos, canStudentAccessVideo } from './video.js';
import { getSchool } from './school.js';
import { makeStudentOwnerId } from './entitlements.js';

// 시청 기록 HTTP 액션. 라우터(api/videos/[action].js)는 인증만 하고 여기로 넘긴다 — Vercel 함수 파일
// 개수 한도 때문에 라우트 파일을 늘릴 수 없어, 대신 라우터를 얇게 유지한다(Codex 검토 반영).
export const OWNER_WATCH_ACTIONS = ['watch-mine', 'watch-confirm', 'watch-progress'];
export const ADMIN_WATCH_ACTIONS = ['watch-admin-list', 'watch-admin-set', 'watch-admin-week'];

const WEEKS = ['1주', '2주', '3주', '4주', '5주'];

export async function handleOwnerWatchAction(action, req, res, owner) {
  if (action === 'watch-mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const videoIds = String(req.query.videoIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoIds.length) return res.status(200).json({ success: true, statuses: {} });
    const statuses = await listWatchStatuses(owner.ownerType, owner.ownerId, videoIds);
    return res.status(200).json({ success: true, statuses });
  }

  // 옛 "다 봤어요" — 화면에서는 제거됐지만 기존 데이터 호환을 위해 API는 남긴다.
  if (action === 'watch-confirm') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { videoId } = req.body || {};
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    const record = await selfConfirmWatch(owner.ownerType, owner.ownerId, videoId);
    return res.status(200).json({ success: true, record });
  }

  // 재생기가 15초마다·이탈 시 보내는 실제 재생 구간. 재생 주소 발급과 같은 기준으로 "보이는 영상"만 받는다.
  if (action === 'watch-progress') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    if (!await checkRateLimit('watch-progress', `${owner.ownerType}:${owner.ownerId}`, 60, 60)) {
      return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });
    }
    const { videoId, durationSec, segments, lastPositionSec } = req.body || {};
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    const visible = await listVisibleVideosForOwner(owner);
    if (!visible.some(v => v.id === videoId)) return res.status(404).json({ success: false, message: '볼 수 없는 영상입니다' });
    try {
      const record = await recordProgress(owner.ownerType, owner.ownerId, videoId, { durationSec, segments, lastPositionSec });
      return res.status(200).json({ success: true, record });
    } catch (e) {
      if (e.code === 'BAD_INPUT') return res.status(400).json({ success: false, message: e.message });
      throw e;
    }
  }
  return res.status(404).json({ success: false, message: 'Not found' });
}

function summarizeStudent(records) {
  let completed = 0, best = null;
  for (const r of records) {
    if (!r) continue;
    const done = r.status === 'auto_completed' || r.status === 'teacher_confirmed';
    if (done) completed++;
    const ratio = r.progress?.ratio || 0;
    const score = (done ? 1 : 0) * 10 + ratio;
    if (!best || score > best.score) best = { score, videoId: r.videoId, ratio, status: r.status, flags: r.progress?.flags || [] };
  }
  if (best) delete best.score;
  return { completed, best };
}

export async function handleAdminWatchAction(action, req, res, admin) {
  if (action === 'watch-admin-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const videoId = String(req.query.videoId || '');
    const schoolId = String(req.query.schoolId || '');
    const studentIds = String(req.query.studentIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoId || !schoolId || !studentIds.length) return res.status(400).json({ success: false, message: 'Missing videoId/schoolId/studentIds' });
    const entries = await Promise.all(studentIds.map(async sid => {
      const [status] = Object.values(await listWatchStatuses('student', makeStudentOwnerId(schoolId, sid), [videoId]));
      return [sid, status || null];
    }));
    return res.status(200).json({ success: true, statuses: Object.fromEntries(entries) });
  }

  if (action === 'watch-admin-set') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { ownerType, memberId, schoolId, studentId, videoId, status } = req.body || {};
    if (!videoId || !status) return res.status(400).json({ success: false, message: 'Missing videoId/status' });
    if (!['teacher_confirmed', 'exempt', 'opened'].includes(status)) return res.status(400).json({ success: false, message: '허용되지 않은 status' });
    let resolvedType, resolvedId;
    if (ownerType === 'member' || memberId) { resolvedType = 'member'; resolvedId = memberId; }
    else if (schoolId && studentId) { resolvedType = 'student'; resolvedId = makeStudentOwnerId(schoolId, studentId); }
    if (!resolvedType || !resolvedId) return res.status(400).json({ success: false, message: 'Missing owner 정보' });
    const record = await teacherSetWatchStatus(resolvedType, resolvedId, videoId, status, admin.actorName || admin.actorId || 'admin');
    return res.status(200).json({ success: true, record });
  }

  // 인강/현강 체크 화면용 — 한 학교의 한 달(또는 한 주차)에 대해 학생별 완료 수. 읽기 수는 학생 × 그 주차 영상.
  if (action === 'watch-admin-week') {
    if (req.method !== 'GET') return res.status(405).end();
    const schoolId = String(req.query.schoolId || '');
    const month = String(req.query.month || '');
    const week = String(req.query.week || '');
    if (!schoolId || !month) return res.status(400).json({ success: false, message: 'Missing schoolId/month' });
    const school = await getSchool(schoolId);
    if (!school) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    const students = school.students || [];
    const all = (await listAllVideos()).filter(v => v.month === month && (!week || v.week === week));
    const weeks = {};
    for (const wk of (week ? [week] : WEEKS)) {
      const videos = all.filter(v => v.week === wk);
      const perStudent = {};
      for (const s of students) {
        const mine = videos.filter(v => canStudentAccessVideo(v, schoolId, s.id));
        if (!mine.length) { perStudent[s.id] = { completed: 0, total: 0, best: null }; continue; }
        const statuses = await listWatchStatuses('student', makeStudentOwnerId(schoolId, s.id), mine.map(v => v.id));
        const { completed, best } = summarizeStudent(mine.map(v => statuses[v.id]));
        perStudent[s.id] = { completed, total: mine.length, best };
      }
      weeks[wk] = { videos: videos.map(v => ({ id: v.id, title: v.title })), students: perStudent };
    }
    return res.status(200).json({ success: true, weeks, completeRatio: WATCH_COMPLETE_RATIO });
  }
  return res.status(404).json({ success: false, message: 'Not found' });
}
```

- [ ] **Step 4: 라우터를 얇게 — `api/videos/[action].js` 전체 교체**
```js
import { requireAdminSessionOrApiToken, requireStudentSession, requireOwnerSession, isSameOrigin, checkRateLimit } from '../_lib/auth.js';
import { listAllVideos, saveVideo, deleteVideo, isValidDropboxVideoPath } from '../_lib/video.js';
import { makeStudentOwnerId } from '../_lib/entitlements.js';
import { listVisibleVideosForOwner, resolvePlayUrl } from '../_lib/playback.js';
import { listVideoFolder } from '../_lib/dropbox.js';
import { OWNER_WATCH_ACTIONS, ADMIN_WATCH_ACTIONS, handleOwnerWatchAction, handleAdminWatchAction } from '../_lib/watch-actions.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 영상 카탈로그 + 드롭박스 재생 + 시청기록 라우트. Vercel Hobby 플랜의 서버리스 함수 12개 제한 때문에
// 새 파일로 나누지 않고, 시청기록 액션은 _lib/watch-actions.js에 위임해 이 파일을 얇게 유지한다.
export default async function handler(req, res) {
  const { action } = req.query;

  if (action === 'mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const session = await requireStudentSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
    // 학교가 배정한 영상 + 학생 본인이 직접 구매한 유료 강좌 영상. 재생 주소 발급(play-url)도 같은
    // 함수로 "보이는 영상"을 판정하므로, 목록에 보이는 것과 재생되는 것이 항상 일치한다.
    const videos = await listVisibleVideosForOwner({ ownerType: 'student', ownerId: makeStudentOwnerId(session.schoolId, session.studentId) });
    return res.status(200).json({ success: true, videos });
  }

  // 재생 화면이 열리는 순간 호출 — 로그인·접근권한·시청 기간을 모두 통과해야 4시간짜리 드롭박스
  // 임시 주소를 준다. 주소는 저장하지 않고 매번 새로 발급하며, 응답도 캐시되지 않게 한다.
  if (action === 'play-url') {
    if (req.method !== 'GET') return res.status(405).end();
    res.setHeader('Cache-Control', 'no-store');
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!await checkRateLimit('play-url', `${owner.ownerType}:${owner.ownerId}`, 30, 60)) {
      return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });
    }
    const videoId = String(req.query.videoId || '');
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    const result = await resolvePlayUrl(owner, videoId);
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    return res.status(200).json({ success: true, url: result.url });
  }

  if (OWNER_WATCH_ACTIONS.includes(action)) {
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    return handleOwnerWatchAction(action, req, res, owner);
  }

  const admin = await requireAdminSessionOrApiToken(req);
  if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized' });

  if (ADMIN_WATCH_ACTIONS.includes(action)) return handleAdminWatchAction(action, req, res, admin);

  if (action === 'list') {
    if (req.method !== 'GET') return res.status(405).end();
    const videos = await listAllVideos();
    return res.status(200).json({ success: true, videos });
  }

  if (action === 'save') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { title, availableFrom, availableUntil } = req.body || {};
    if (!String(title || '').trim()) return res.status(400).json({ success: false, message: '제목을 입력하세요' });
    const from = String(availableFrom || '');
    const until = String(availableUntil || '');
    if (DATE_RE.test(from) && DATE_RE.test(until) && from > until) {
      return res.status(400).json({ success: false, message: '시작일이 종료일보다 늦습니다' });
    }
    const video = await saveVideo(req.body || {});
    return res.status(200).json({ success: true, video });
  }

  if (action === 'delete') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: 'Missing id' });
    await deleteVideo(id);
    return res.status(200).json({ success: true });
  }

  // 관리자 영상 폼의 "드롭박스에서 고르기" — 앱 폴더 videos/의 파일 중 영상 파일만.
  if (action === 'dropbox-list') {
    if (req.method !== 'GET') return res.status(405).end();
    try {
      const { files, folderMissing } = await listVideoFolder();
      return res.status(200).json({ success: true, files: files.filter(f => isValidDropboxVideoPath(f.path)), folderMissing });
    } catch (e) {
      if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ success: false, message: '드롭박스가 아직 연결되지 않았습니다' });
      console.error('[dropbox] dropbox-list failed:', e.message, e.detail || '');
      return res.status(502).json({ success: false, message: '드롭박스 목록을 불러오지 못했습니다' });
    }
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
```

- [ ] **Step 5: 통과 확인** — 새 테스트 2개 PASS; `npm test` 87/87(기존 `tests/watch.test.mjs`·`tests/playback.test.mjs` 포함); `find api -name "*.js" -not -path "*/_lib/*" | wc -l` → 12.

- [ ] **Step 6: 커밋**
```bash
git add api/_lib/watch-actions.js "api/videos/[action].js" tests/watch-actions.test.mjs
git commit -m "$(cat <<'EOF'
시청기록 액션을 watch-actions로 분리하고 watch-progress·watch-admin-week 추가

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 재생기 자동 기록 + 이어보기 + "다 봤어요" 제거 — 4단계

**Files:** Modify `lecture.html`

**Interfaces:**
- Consumes: `POST /api/videos/watch-progress`, `GET /api/videos/watch-mine`(레코드에 `progress`)
- Produces: `watchProgressHtml(record)`, `renderWatchProgress(record)` — Task 6도 사용

- [ ] **Step 1: 상태 표시 함수 교체**

기존 `function watchStatusHtml(status){ ... }`와 `async function loadAndRenderWatchStatus(videoId){ ... }` 두 함수(그리고 그 위 주석 "실제 재생 이벤트를 아직 못 잡는 동안의…")를 통째로 아래로 교체:
```js
// 자동 기록 표시 — "재생 기준"임을 문구에 남긴다. 선생님 정정값이 항상 우선.
function watchProgressHtml(rec){
  const box=(bg,bd,fg,text)=>`<div style="background:${bg};border:1px solid ${bd};border-radius:12px;padding:14px 16px;font-size:13px;color:${fg}">${text}</div>`;
  if(rec?.status==='teacher_confirmed')return box('#E0F2E9','#B9E4CE','#00695C','✓ 선생님 확인 완료');
  if(rec?.status==='exempt')return box('var(--lightbg)','var(--border)','var(--navy-soft)','선생님이 시청 제외로 처리한 영상이에요');
  if(rec?.status==='auto_completed')return box('#E0F2E9','#B9E4CE','#00695C','✓ 재생 완료 (90% 이상)');
  const p=rec?.progress;
  if(p&&p.durationSec)return box('var(--lightbg)','var(--border)','var(--navy-soft)',`재생 기준 ${Math.round((p.ratio||0)*100)}% 시청`);
  return'';
}
function renderWatchProgress(rec){
  const wrap=document.getElementById('watch-status-wrap');
  if(wrap)wrap.innerHTML=watchProgressHtml(rec);
}
```

- [ ] **Step 2: 재생기에 구간 수집·전송·이어보기**

`wirePlayer` 안, 기존 줄 `const stillHere=()=>ST.screen==='player'&&ST.active?.id===videoId&&video.isConnected;` **바로 다음**에 추가:
```js
  // 실제 재생한 구간만 모은다 — 두 timeupdate 사이 간격이 배속 기준 1.5초를 넘으면(건너뛰기·되감기)
  // 구간이 끊겨 자동으로 빠진다. 15초마다, 일시정지·종료·화면 이탈 때 서버로 보낸다.
  let lastT=null,pending=[];
  const trackTime=()=>{
    const t=video.currentTime;if(!isFinite(t))return;
    if(lastT!==null){const d=t-lastT;if(d>0&&d<=1.5*(video.playbackRate||1)+0.25)pending.push([lastT,t]);}
    lastT=t;
  };
  const flushProgress=(leaving)=>{
    if(!pending.length||!video.duration||!isFinite(video.duration))return;
    const body=JSON.stringify({videoId,durationSec:Math.round(video.duration),segments:pending.map(([s,e])=>[Math.floor(s),Math.ceil(e)]),lastPositionSec:Math.floor(video.currentTime||0)});
    pending=[];
    if(leaving&&navigator.sendBeacon){navigator.sendBeacon('/api/videos/watch-progress',new Blob([body],{type:'application/json'}));return;}
    fetch('/api/videos/watch-progress',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body,keepalive:true})
      .then(r=>r.json()).then(d=>{if(d.success&&stillHere())renderWatchProgress(d.record);}).catch(()=>{});
  };
  video.addEventListener('timeupdate',trackTime);
  video.addEventListener('seeking',()=>{lastT=null;});
  video.addEventListener('pause',()=>flushProgress(false));
  video.addEventListener('ended',()=>flushProgress(false));
  const sendTimer=setInterval(()=>{if(!video.paused)flushProgress(false);},15000);
  const onVisibility=()=>{if(document.visibilityState==='hidden')flushProgress(true);};
  const onPageHide=()=>flushProgress(true);
  document.addEventListener('visibilitychange',onVisibility);
  window.addEventListener('pagehide',onPageHide);
  ST.vpProgressCleanup=()=>{clearInterval(sendTimer);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('pagehide',onPageHide);flushProgress(true);};

  // 이어보기 + 현재 상태 표시. 영상 정보가 먼저 준비돼 있으면 바로 위치를 옮긴다.
  fetch('/api/videos/watch-mine?videoIds='+encodeURIComponent(videoId),{credentials:'include'})
    .then(r=>r.json()).then(d=>{
      if(!stillHere())return;
      const rec=d.success?d.statuses[videoId]:null;
      renderWatchProgress(rec);
      const p=rec?.progress;
      if(p&&p.lastPositionSec>5&&p.durationSec-p.lastPositionSec>10){
        if(video.readyState>=1)video.currentTime=p.lastPositionSec;else resumeAt=p.lastPositionSec;
      }
    }).catch(()=>{});
```
같은 함수 안의 기존 `loadedmetadata` 처리기에서 `if(resumeAt){video.currentTime=resumeAt;resumeAt=0;}`는 그대로 둔다(이어보기 위치가 여기서 적용됨).

- [ ] **Step 3: 정리 함수·wireApp**

기존 `function teardownPlayer(){` 안 첫 줄 `if(ST.vpMarkTimer){...}` **앞**에 추가:
```js
  if(ST.vpProgressCleanup){const f=ST.vpProgressCleanup;ST.vpProgressCleanup=null;f();}
```
`wireApp()`의 기존 줄:
```js
  if(ST.screen==='player'&&ST.active){loadAndRenderWatchStatus(ST.active.id);wirePlayer();}
```
교체:
```js
  if(ST.screen==='player'&&ST.active)wirePlayer();
```

- [ ] **Step 4: 확인 + 커밋**

문법 검사(1 block), `npm test` 87/87. 파일 안에 `watch-confirm`·`다 봤어요` 문자열이 남아있지 않은지 `grep -c "watch-confirm\|다 봤어요" lecture.html` → 0.
```bash
git add lecture.html
git commit -m "$(cat <<'EOF'
재생기가 실제 재생 구간을 자동 기록하고 이어보기 지원, "다 봤어요" 버튼 제거

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 내 강의실 + 성적표 시청률 — 5단계 ①

**Files:** Modify `lecture.html`, `index.html`

**Interfaces:**
- Consumes: `GET /api/videos/mine`(학생)·`GET /api/courses/mine`(회원)·`GET /api/videos/watch-mine?videoIds=`
- Produces: `lecture.html` `ST.watch`(videoId→record), `loadWatchMap(videos)`, `watchBadge(v)`; `index.html` `loadReportLecture(month, week)`

- [ ] **Step 1: `lecture.html` — 시청 상태 한 번에 읽기**

`async function loadPublicCourses(){` 바로 **위**에 추가:
```js
// 목록 뱃지용 — 보이는 영상 전체의 시청 상태를 한 번에.
async function loadWatchMap(videos){
  const ids=(videos||[]).map(v=>v.id);
  if(!ids.length)return{};
  try{
    const res=await fetch('/api/videos/watch-mine?videoIds='+encodeURIComponent(ids.join(',')),{credentials:'include'});
    const d=await res.json();
    return d.success?d.statuses:{};
  }catch(e){return{};}
}
```
`boot()` 안 두 곳, `ST.videos=await loadStudentVideos();ST.screen='list';render();return;`와 `ST.videos=await loadMemberVideos();ST.screen='list';render();return;`를 각각:
```js
ST.videos=await loadStudentVideos();ST.watch=await loadWatchMap(ST.videos);ST.screen='list';render();return;
```
```js
ST.videos=await loadMemberVideos();ST.watch=await loadWatchMap(ST.videos);ST.screen='list';render();return;
```
`wireNavDelegation`의 `if(nav==='list'){...}` 줄을:
```js
    if(nav==='list'){ST.videos=ST.mode==='member'?await loadMemberVideos():await loadStudentVideos();ST.watch=await loadWatchMap(ST.videos);ST.active=null;ST.screen='list';render();}
```
`wireApp()`의 기존 `document.getElementById('btn-back')?.addEventListener('click',()=>{ST.screen='list';ST.active=null;render();});`를:
```js
  document.getElementById('btn-back')?.addEventListener('click',async()=>{ST.watch=await loadWatchMap(ST.videos);ST.screen='list';ST.active=null;render();});
```

- [ ] **Step 2: `lecture.html` — 뱃지·이번 주 요약**

CSS(`.vcard-tag.ended{...}` 줄 다음에 추가):
```css
  .vcard-tag.done{background:#E0F2E9;color:#00695C}
  .vcard-tag.warn{background:#FFF3E0;color:#E65100}
  .wk-summary{background:linear-gradient(135deg,var(--navy),#2F3A7A);color:#fff;border-radius:16px;padding:18px 20px;margin-bottom:18px}
  .wk-summary .t{font-size:12px;opacity:.75;font-weight:700;letter-spacing:.5px;margin-bottom:6px}
  .wk-summary .row{display:flex;align-items:center;gap:10px;font-size:13.5px;margin-top:8px}
  .wk-summary .bar{flex:1;height:6px;background:rgba(255,255,255,.2);border-radius:3px;overflow:hidden}
  .wk-summary .bar>div{height:100%;background:var(--coral);border-radius:3px}
  .wk-summary .pct{font-variant-numeric:tabular-nums;min-width:38px;text-align:right;font-weight:700}
```
기존 `function videoCard(v){ ... }`를 교체:
```js
function watchBadge(v){
  const rec=(ST.watch||{})[v.id];
  if(rec?.status==='teacher_confirmed'||rec?.status==='auto_completed')return`<span class="vcard-tag done">완료</span>`;
  if(rec?.status==='exempt')return`<span class="vcard-tag">제외</span>`;
  const p=rec?.progress;
  if(p&&p.durationSec)return`<span class="vcard-tag">${Math.round((p.ratio||0)*100)}%</span>`;
  return`<span class="vcard-tag">미시청</span>`;
}
function videoCard(v){
  return`<div class="vcard${v.availability==='ended'?' ended':''}" data-vid="${v.id}">
    <div class="vcard-title">🎬 ${esc(v.title)}${v.availability==='ended'?videoAvailTag(v):watchBadge(v)+videoAvailTag(v)}</div>
  </div>`;
}
function weekSummaryHtml(list,label){
  const rows=list.map(v=>{
    const rec=(ST.watch||{})[v.id];
    const done=rec?.status==='teacher_confirmed'||rec?.status==='auto_completed';
    const pct=done?100:Math.round(((rec?.progress?.ratio)||0)*100);
    return`<div class="row"><span style="flex:1.2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.title)}</span><div class="bar"><div style="width:${pct}%"></div></div><span class="pct">${done?'완료':pct+'%'}</span></div>`;
  }).join('');
  return`<div class="wk-summary"><div class="t">이번 주 · ${esc(label)}</div>${rows}</div>`;
}
```
`listScreen()`의 학생 분기에서 기존 줄:
```js
  const undatedSection=undated.length?`<div class="wk-head">기타 자료 · ${undated.length}개</div>${undated.map(videoCard).join('')}`:'';
  return weekSections+undatedSection;
```
교체:
```js
  const undatedSection=undated.length?`<div class="wk-head">기타 자료 · ${undated.length}개</div>${undated.map(videoCard).join('')}`:'';
  const latest=weekKeys[0];
  const summary=latest?weekSummaryHtml(dated.filter(v=>v.month+'_'+v.week===latest),latest.replace('_',' ')):'';
  return summary+weekSections+undatedSection;
```
`.vcard-tag`의 기존 CSS `margin-left:auto`가 두 뱃지에 모두 적용되므로 두 번째 뱃지에는 여백을 줄인다 — `.vcard-tag.ended{...}` 줄 위에 추가:
```css
  .vcard-tag+.vcard-tag{margin-left:6px}
```

- [ ] **Step 3: `index.html` — 성적표에 이번 주 인강**

`rReport()`의 기존 줄(공지 블록 닫힘 뒤, 이미지 저장 버튼 앞):
```html
  <button id="btn-save-report-img" class="no-print rpt-focus"
```
바로 **위**에 추가:
```html
  <div id="rpt-lecture" class="no-print" data-month="${esc(rec.month)}" data-week="${esc(rec.week)}"></div>
```
`function rReport(recs){` 바로 **위**에 추가:
```js
// 성적표의 "이번 주 인강" — 학부모가 아이 계정으로 보는 화면이므로 "재생 완료"로만 표기(봤다고 단정하지 않음).
async function loadReportLecture(month,week){
  const box=document.getElementById('rpt-lecture');
  if(!box)return;
  try{
    const vr=await fetch('/api/videos/mine',{credentials:'include'});const vd=await vr.json();
    const vids=(vd.success?vd.videos:[]).filter(v=>v.month===month&&v.week===week);
    if(!vids.length){box.innerHTML='';return;}
    const wr=await fetch('/api/videos/watch-mine?videoIds='+encodeURIComponent(vids.map(v=>v.id).join(',')),{credentials:'include'});
    const wd=await wr.json();const st=wd.success?wd.statuses:{};
    const rows=vids.map(v=>{
      const rec=st[v.id];const done=rec?.status==='teacher_confirmed'||rec?.status==='auto_completed';
      const pct=done?100:Math.round(((rec?.progress?.ratio)||0)*100);
      const label=rec?.status==='teacher_confirmed'?'선생님 확인':done?'재생 완료':rec?.status==='exempt'?'제외':pct?`${pct}% 시청`:'미시청';
      const color=done?'#00897B':pct?'#1E40AF':'#9BA3AF';
      return`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #F0F2F5;font-size:13px;color:#12151C"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🎬 ${esc(v.title)}</span><span style="font-weight:700;color:${color};white-space:nowrap">${label}</span></div>`;
    }).join('');
    box.innerHTML=`<div style="background:#fff;border:1.5px solid #D9E0EA;border-radius:12px;padding:14px 16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-size:11px;font-weight:800;color:#57616F;letter-spacing:1px">이번 주 인강</span><a href="/lecture.html" style="font-size:12px;font-weight:700;color:#1E40AF;text-decoration:none">인강 보러가기 →</a></div>${rows}</div>`;
  }catch(e){box.innerHTML='';}
}
```
`bStudent()`의 기존 줄 `requestAnimationFrame(()=>drawMockCharts());` **다음**에 추가:
```js
  const rl=document.getElementById('rpt-lecture');
  if(rl)loadReportLecture(rl.dataset.month,rl.dataset.week);
```

- [ ] **Step 4: 확인 + 커밋**

두 파일 문법 검사, `npm test` 87/87. 브라우저(컨트롤러): 학생 로그인 → 내 강의실에 "이번 주" 카드와 뱃지; 성적표에 "이번 주 인강" 칸(그 주차에 영상 없으면 안 보임).
```bash
git add lecture.html index.html
git commit -m "$(cat <<'EOF'
학생 내 강의실(이번 주 요약·시청률 뱃지)과 성적표 '이번 주 인강' 표시

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 영상 관리 — 영상별 학생 시청 현황 — 5단계 ②

**Files:** Modify `index.html`

**Interfaces:**
- Consumes: `GET /api/videos/watch-admin-list?videoId&schoolId&studentIds`(레코드에 `progress`), `POST /api/videos/watch-admin-set`

- [ ] **Step 1: 목록 행에 버튼 + 펼침 영역**

`rVideos()`의 `listRows` 안 기존 줄:
```html
        <button data-video-exc="${v.id}" style="padding:4px 9px;background:#EEF0FB;color:#1A237E;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;margin-right:4px">학생 예외</button>
```
바로 **위**에 추가:
```html
        <button data-video-watch="${v.id}" style="padding:4px 9px;background:#E0F2E9;color:#00695C;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;margin-right:4px">시청 현황</button>
```
같은 행 템플릿의 마지막 `</tr>` **바로 앞**에는 아무것도 넣지 않고, 대신 `return\`<tr>...</tr>\`;}).join('');` 의 `</tr>\`` 를 아래처럼 바꿔 펼침 행을 붙인다:
```js
    </tr>${ST.videoWatchId===v.id?`<tr><td colspan="5" style="padding:0 12px 14px"><div id="video-watch-panel" style="background:#F7F8FA;border-radius:10px;padding:12px 14px;font-size:12.5px;color:#12151C">불러오는 중...</div></td></tr>`:''}`;}).join('');
```

- [ ] **Step 2: 현황 렌더 함수**

`function rVideos(sc){` 바로 **위**에 추가:
```js
// 영상별 학생 시청 현황 — 현재 선택된 학교의 활성 학생 기준. 자동 기록은 "재생 완료/N%"로만 쓰고,
// 빠른 진행 의심은 "확인 필요"로 표시해 선생님이 판단하게 한다.
async function renderVideoWatch(videoId,sc){
  const panel=document.getElementById('video-watch-panel');
  if(!panel)return;
  const students=sc.students||[];
  if(!students.length){panel.innerHTML='<span style="color:#9BA3AF">이 학교에 학생이 없습니다</span>';return;}
  try{
    const res=await fetch(`/api/videos/watch-admin-list?videoId=${encodeURIComponent(videoId)}&schoolId=${encodeURIComponent(sc.id)}&studentIds=${encodeURIComponent(students.map(s=>s.id).join(','))}`,{credentials:'include'});
    const d=await res.json();
    if(!d.success){panel.innerHTML=`<span style="color:#E53935">${esc(d.message||'불러오지 못했습니다')}</span>`;return;}
    const rows=students.map(s=>{
      const rec=d.statuses[s.id];const p=rec?.progress;
      const pct=Math.round(((p?.ratio)||0)*100);
      let label,color;
      if(rec?.status==='teacher_confirmed'){label='선생님 확인';color='#00695C';}
      else if(rec?.status==='exempt'){label='제외';color='#9BA3AF';}
      else if(rec?.status==='auto_completed'){label='재생 완료';color='#00897B';}
      else if(rec?.status==='self_confirmed'){label='학생 자기확인(옛 기록)';color='#5C6470';}
      else if(p){label=`${pct}% 시청`;color='#1E40AF';}
      else{label='미시청';color='#9BA3AF';}
      const warn=(p?.flags||[]).includes('fast_progress')?`<span style="margin-left:6px;font-size:10.5px;font-weight:700;color:#E65100;background:#FFF3E0;border-radius:20px;padding:2px 7px">확인 필요</span>`:'';
      const last=p?.updatedAt?p.updatedAt.slice(0,10):'';
      return`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #EEF0F3">
        <span style="font-weight:700;color:#1A237E;min-width:64px">${esc(s.name)}</span>
        <span style="flex:1;color:${color};font-weight:700">${label}${warn}</span>
        <span style="color:#9BA3AF;font-size:11px;white-space:nowrap">${last}</span>
        <button data-watch-set="${s.id}|teacher_confirmed" style="padding:3px 8px;background:#E0F2E9;color:#00695C;border:none;border-radius:6px;font-size:11px;cursor:pointer">확인</button>
        <button data-watch-set="${s.id}|exempt" style="padding:3px 8px;background:#F1F3F5;color:#5C6470;border:none;border-radius:6px;font-size:11px;cursor:pointer">제외</button>
      </div>`;
    }).join('');
    panel.innerHTML=`<div style="font-size:11px;color:#9BA3AF;margin-bottom:6px">재생 완료 = 재생기 기준 90% 이상. 실제로 봤는지는 알 수 없으니 "확인 필요"는 직접 판단해주세요.</div>${rows}`;
    panel.querySelectorAll('[data-watch-set]').forEach(b=>{
      b.onclick=async()=>{
        const[studentId,status]=b.dataset.watchSet.split('|');
        b.disabled=true;
        try{
          const r=await fetch('/api/videos/watch-admin-set',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({schoolId:sc.id,studentId,videoId,status})});
          const dd=await r.json();
          if(!r.ok||!dd.success){alert(dd.message||'저장 실패');b.disabled=false;return;}
        }catch(e){alert('오류: '+e.message);b.disabled=false;return;}
        renderVideoWatch(videoId,sc);
      };
    });
  }catch(e){panel.innerHTML='<span style="color:#E53935">불러오지 못했습니다</span>';}
}
```

- [ ] **Step 3: 버튼 연결**

`bAdmin()` 안(함수 첫 줄이 `const sc=curSch();`), 기존 줄 `    document.querySelectorAll('[data-video-exc]').forEach(b=>{` 바로 **위**에 추가(`sc`는 이 스코프의 현재 학교 객체):
```js
    document.querySelectorAll('[data-video-watch]').forEach(b=>{
      b.onclick=()=>{ST.videoWatchId=ST.videoWatchId===b.dataset.videoWatch?null:b.dataset.videoWatch;render();};
    });
    if(ST.videoWatchId)renderVideoWatch(ST.videoWatchId,sc);
```

- [ ] **Step 4: 확인 + 커밋**

문법 검사(2 blocks), `npm test`. 브라우저: 영상 관리 → 시청 현황 → 학생별 표시, 확인/제외 저장 후 즉시 반영.
```bash
git add index.html
git commit -m "$(cat <<'EOF'
영상 관리에 영상별 학생 시청 현황(재생 완료·N%·확인 필요) 추가

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 인강/현강 체크에 완료 제안 — 6단계

**Files:** Modify `index.html`

**Interfaces:**
- Consumes: `GET /api/videos/watch-admin-week?schoolId&month` → `weeks[week].students[sid] = {completed,total,best}`; 기존 `bindAttSelectDraft(sel, onLocalChange)`(select의 `onchange`로 동작)

- [ ] **Step 1: 칸에 제안 자리**

`rAttendance()`의 기존 `cells` 템플릿:
```html
      return`<td style="padding:4px"><select data-att-sid="${s.id}" data-att-wk="${wk}" style="width:100%;padding:6px 4px;border:1.5px solid #E8ECF0;border-radius:7px;font-size:11px;text-align:center;font-weight:700;color:${color};background:#fff;outline:none;cursor:pointer">
        ${attOptionsHtml(val)}
      </select></td>`;
```
교체:
```html
      return`<td style="padding:4px"><select data-att-sid="${s.id}" data-att-wk="${wk}" style="width:100%;padding:6px 4px;border:1.5px solid #E8ECF0;border-radius:7px;font-size:11px;text-align:center;font-weight:700;color:${color};background:#fff;outline:none;cursor:pointer">
        ${attOptionsHtml(val)}
      </select><div data-att-suggest="${s.id}|${wk}" style="min-height:14px;margin-top:3px;text-align:center"></div></td>`;
```
안내 문구 줄 `주차별로 현강(O)·인강·결석 중 선택한 뒤, 저장하기 버튼을 눌러야 실제로 저장됩니다. 성적 입력과 별개로 관리돼요.` 뒤에 붙임: ` 칸 아래 "인강 N%"는 재생 기록 기준 제안이라, 눌러야만 값이 들어갑니다.`

- [ ] **Step 2: 제안 불러와 채우기**

`function rAttendance(sc){` 바로 **위**에 추가:
```js
// 인강/현강 체크의 완료 제안 — 자동 저장하지 않는다. 누르면 그 칸의 선택값만 '인강'으로 바꾸고,
// 실제 저장은 기존 "저장하기" 흐름을 그대로 탄다(Codex 검토: 손입력 출결을 자동으로 덮지 않을 것).
async function loadAttSuggestions(sc,mon){
  try{
    const res=await fetch(`/api/videos/watch-admin-week?schoolId=${encodeURIComponent(sc.id)}&month=${encodeURIComponent(mon)}`,{credentials:'include'});
    const d=await res.json();
    if(!d.success)return;
    document.querySelectorAll('[data-att-suggest]').forEach(box=>{
      const[sid,wk]=box.dataset.attSuggest.split('|');
      const s=d.weeks?.[wk]?.students?.[sid];
      if(!s||!s.total){box.innerHTML='';return;}
      const best=s.best;const pct=Math.round(((best?.ratio)||0)*100);
      const done=s.completed>0;
      const warn=(best?.flags||[]).includes('fast_progress');
      const color=warn?'#E65100':done?'#00897B':'#9BA3AF';
      const bg=warn?'#FFF3E0':done?'#E0F2E9':'#F1F3F5';
      const text=done?`인강 완료 ${s.completed}/${s.total}${warn?' · 확인 필요':''}`:`인강 ${pct}%`;
      box.innerHTML=`<button type="button" data-att-apply="${sid}|${wk}" title="누르면 이 칸을 '인강'으로 바꿉니다 (저장하기 필요)" style="font-size:10px;font-weight:700;color:${color};background:${bg};border:none;border-radius:20px;padding:2px 7px;cursor:pointer">${text}</button>`;
    });
    document.querySelectorAll('[data-att-apply]').forEach(b=>{
      b.onclick=()=>{
        const[sid,wk]=b.dataset.attApply.split('|');
        const sel=document.querySelector(`select[data-att-sid="${sid}"][data-att-wk="${wk}"]`);
        if(!sel)return;
        if(sel.value&&sel.value!=='인강'&&!confirm(`이미 "${sel.value}"로 되어 있습니다. '인강'으로 바꿀까요?`))return;
        sel.value='인강';
        if(typeof sel.onchange==='function')sel.onchange();
      };
    });
  }catch(e){}
}
```
출석 탭 바인딩에서 기존 줄 `document.querySelectorAll('[data-att-sid]').forEach(sel=>{` 를 포함한 블록이 끝난 **다음**(즉 `const doAttSave=async()=>{` 줄 바로 위)에 추가:
```js
    loadAttSuggestions(sc, ST.attMon||curMonWk().mon);
```
(`sc`는 그 스코프의 학교 객체 — 이미 `sc.records`로 쓰이고 있다.)

- [ ] **Step 3: 확인 + 커밋**

문법 검사(2 blocks), `npm test`. 브라우저: 학생이 영상을 90% 이상 본 뒤 인강/현강 체크 → 그 칸 아래 "인강 완료 1/1" → 누르면 select가 '인강'으로, 저장하기 누르기 전엔 저장 안 됨, 값이 있는 칸은 확인창.
```bash
git add index.html
git commit -m "$(cat <<'EOF'
인강/현강 체크에 재생 완료 제안 표시 (누를 때만 반영, 자동 저장 없음)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 전체 확인 + 배포 준비 (컨트롤러가 직접)

- [ ] `npm test` 전체 PASS(87), 함수 파일 12개, 두 HTML 문법 검사 OK.
- [ ] `git push`는 사용자 확인 후. 배포 뒤 실제 사이트에서: 워터마크 모서리, 네비 링크 왕복, 성적표↔인강 로그인 유지, 영상 재생 후 새로고침 시 "N% 시청"과 이어보기, 관리자 시청 현황, 인강/현강 제안. 화면을 4시간 넘게 열어둔 뒤 재생 재개는 사용자에게 확인 요청.
- [ ] 계획 문서 끝에 "구현 완료 상태" 절 추가(결정 사항·미뤄둔 항목·Codex 이어받기용).

---

## 구현 완료 상태 (2026-09-12)

**커밋 범위:** `6b26645..c13e355` (b09a8e0 이후 16개 커밋, `main`). 테스트 96/96(`npm test`), 서버리스 함수 파일 12개(변동 없음), `lecture.html` 1블록·`index.html` 2블록 문법 검사 OK.

| 단계 | 커밋 | 내용 |
|---|---|---|
| 1 워터마크·네비 | 6b26645 | 모서리 4곳 소형 워터마크(30초 순환), 로그인 후 내 강의실/강좌/후기(/성적표) 상시 링크, `data-nav` 위임 처리 |
| 2 성적표↔인강 | 1a78e0a | 학생 탭 '인강' → `/lecture.html`, 인강 → `/index.html` (같은 도메인 상대 경로라 로그인 유지) |
| 3 서버 시청 구간 | 127c26a, 87f90a0 | `recordProgress`(구간 병합·90% 완료·선생님 정정 우선·`fast_progress`/`duration_mismatch`) |
| 4 액션 라우팅 | 6fc1de3 | `api/_lib/watch-actions.js` — `watch-progress`, `watch-admin-week` 추가, `[action].js`는 얇은 라우터 |
| 5 재생기 자동 기록 | 3ea4bad | 15초/일시정지/이탈(sendBeacon) 전송, 이어보기, "다 봤어요" 제거 |
| 6 내 강의실·성적표 | 3a47f5b, e42a6e0 | 이번 주 요약·시청률 뱃지, 성적표 '이번 주 인강' 상자 |
| 7 영상별 시청 현황 | 812b295 | 영상 관리 행 펼침 패널, 확인/제외 저장 |
| 8 출결 완료 제안 | 528c01f, cdafd8f | 인강/현강 칸 아래 제안 알약, 누를 때만 반영·자동 저장 없음 |
| 최종 수정 | 77d5ece, 3fdba4c, 2d53bfb, c13e355 | 아래 "최종 검토 반영" 참조 |

**최종 검토(opus) 반영 — 모두 수정됨:**
- 출결 제안에서 `exempt`가 "인강 N%"로 보이던 문제 → 서버 `summarizeStudent`가 exempt를 total에서 빼고, 전부 제외면 클릭 불가 `제외` 칩.
- `watch-admin-week` 학생별 순차 조회 → `Promise.all`.
- `watch-progress`가 목록 전체를 다시 만들던 것 → `isVideoVisibleForOwner(owner, videoId)`(playback.js) + 시청 기간 밖이면 403.
- 첫 보고에서 바로 90% 이상이면 `fast_progress` 표시(선생님 화면에 "확인 필요").
- 재생기: 구간을 로컬에서 먼저 병합(전송량 ↓, 400개 상한 회피), 전송 실패 시 되돌림, 이어보기는 `paused && currentTime<5`일 때만(두 지점 모두).
- 이번 주 요약에서 `upcoming` 영상 제외; 시청 현황 패널은 그 영상을 볼 수 있는 학생만; 선생님 확인/제외 상태엔 "확인 필요" 숨김.

**실행 중 내린 결정(rulings):**
- 옛 `self_confirmed`(다 봤어요) 기록은 모든 화면에서 `학생 확인`으로 표시 — "봤다"로 취급하지 않음.
- 학생/학부모 화면에는 `fast_progress`를 절대 노출하지 않음(관리자 전용).
- 출결은 제안만: `attendType` 쓰기는 기존 초안→저장하기 경로뿐. 이미 값이 있으면 확인창, 이미 '인강'이면 무시.
- 월 전환 중 늦게 온 제안 응답은 버림(주차 키가 월마다 같아서).

**미뤄둔 사소한 항목:**
- 내 강의실 뒤로가기 시 `loadWatchMap` 대기 중 로딩 표시 없음.
- 상태→라벨 매핑이 학생 뱃지/요약/성적표/관리자 패널에 중복(공용 `watchStatusLabel` 후보).
- `watch-admin-list`의 `studentIds` 쿼리는 학생 150명 이상이면 URL 길이 주의.

**배포 후 확인할 것(브라우저, 실제 도메인):** 워터마크 모서리, 네비 왕복, 성적표↔인강 로그인 유지, 재생 후 새로고침 시 "N% 시청"·이어보기, 관리자 시청 현황, 인강/현강 제안·제외 칩. 4시간 넘게 열어둔 뒤 재개는 사용자 확인 필요.

**Codex/다른 세션 이어받기:** 스펙 `docs/superpowers/specs/2026-09-12-lecture-replan-design.md`, 이 계획서, 그리고 다음 계획은 Plan B(7단계 게시판형 후기).
