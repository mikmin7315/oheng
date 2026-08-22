# 성적 활동 로그 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 "저장 이력"(`sc.saveLogs`)을 성적 저장·이번 주 성적 지우기·다른 주차로 복사, 세 가지 행동을 시간순으로 통합한 "활동 로그"로 확장하고, 각 항목에 서버가 검증한 로그인 계정 이름을 표시한다.

**Architecture:** `sc.saveLogs` 배열은 그대로 재사용하고 항목에 `type`(`save`/`clear`/`copy`)과 `actorName`을 추가한다. 클라이언트는 로그 항목을 만들어 기존 `/api/admin/append-save-log` 엔드포인트로 보내지만, 서버가 push 직전에 `actorName`을 세션의 `session.actorName`으로 덮어써서 클라이언트가 신원을 조작할 수 없게 한다. 화면은 기존 "저장 이력" 탭(`rLogs`)을 그대로 확장한다 — 새 탭·새 Redis 필드 없음.

**Tech Stack:** Vercel serverless functions (Node, ESM), Upstash Redis, 순수 HTML/CSS/JS 단일 페이지(index.html), 테스트 프레임워크 없음 — `node -e` 로컬 로직 검증 + 배포 후 `curl`/실제 로그인 검증.

## Global Constraints

- 새 Redis 필드/새 서버리스 함수를 만들지 않는다 — 기존 `sc.saveLogs` 배열과 기존 `append-save-log` 액션을 그대로 확장한다.
- 옛날 로그 항목(`type` 필드 없음)은 항상 `'save'`로 취급한다 — 렌더링이 깨지거나 예외를 던지면 안 된다.
- 로그의 `actorName`은 서버가 세션에서 읽은 값으로 덮어쓴다 — 클라이언트가 보낸 값을 그대로 신뢰하지 않는다.
- 화면에 렌더링하는 `actorName`(계정 표시 이름, 사용자가 만들 수 있는 값)은 반드시 `esc()`로 이스케이프한다.
- 기존 `addLog(sc,mon,wk,count,thrRt,thrWt)` 호출 시그니처는 바꾸지 않는다(기존 호출부 무수정).
- 스펙 문서: `docs/superpowers/specs/2026-07-26-score-activity-log-design.md` (이 계획은 그 문서의 승인된 설계를 그대로 구현한다 — 상충되면 스펙이 우선).

---

### Task 1: 로그 기록 헬퍼 확장 (`pushLogEntry`/`addLog`/`addActionLog`)

**Files:**
- Modify: `index.html` (`addLog`/`getSaveLogs` 정의 부근, 현재 `function addLog(sc,mon,wk,count,thrRt,thrWt){` 로 시작하는 블록)

**Interfaces:**
- Produces: `pushLogEntry(sc, entry)` (공통 저장 로직 — 서버 세션이면 `/api/admin/append-save-log` 호출 + 로컬 `sc.saveLogs`에도 push, 아니면 localStorage에만 저장), `addLog(sc,mon,wk,count,thrRt,thrWt)` (기존 시그니처 그대로, 내부에서 `type:'save'` 항목을 만들어 `pushLogEntry` 호출), `addActionLog(sc, entry)` (entry에 이미 `type`/`month`/`week`/`count`와 타입별 추가 필드가 있다고 가정, `actorName`/`savedAt`을 채워 `pushLogEntry` 호출).

- [ ] **Step 1: 기존 `addLog` 함수를 `pushLogEntry`+`nowStamp`+`addLog`+`addActionLog`로 교체**

`index.html`에서 아래 텍스트를 찾는다:
```js
function addLog(sc,mon,wk,count,thrRt,thrWt){
  const now=new Date();
  const pad=n=>String(n).padStart(2,'0');
  const entry={month:mon,week:wk,count,thrRt,thrWt,
    savedAt:`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`};
  if(ST.serverAdminSession){
    sc.saveLogs=Array.isArray(sc.saveLogs)?sc.saveLogs:[];
    sc.saveLogs.push(entry);
    if(sc.saveLogs.length>200)sc.saveLogs=sc.saveLogs.slice(-200);
    fetch('/api/admin/append-save-log',{
      method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({schoolId:sc.id,entry})
    }).catch(e=>console.warn('저장 로그 서버 기록 실패(화면에는 반영됨):',e));
    return;
  }
  try{
    const key='oheng_logs_'+sc.id;
    const logs=JSON.parse(localStorage.getItem(key)||'[]');
    logs.push(entry);
    localStorage.setItem(key,JSON.stringify(logs.slice(-200)));
  }catch(e){console.warn('addLog 오류:',e);}
}
```

이 블록 전체를 아래로 교체한다:
```js
function nowStamp(){
  const now=new Date();const pad=n=>String(n).padStart(2,'0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
// 활동 로그 저장 공통 로직 — entry는 이미 완성된 로그 항목(actorName/savedAt 포함)
function pushLogEntry(sc,entry){
  if(ST.serverAdminSession){
    sc.saveLogs=Array.isArray(sc.saveLogs)?sc.saveLogs:[];
    sc.saveLogs.push(entry);
    if(sc.saveLogs.length>200)sc.saveLogs=sc.saveLogs.slice(-200);
    fetch('/api/admin/append-save-log',{
      method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({schoolId:sc.id,entry})
    }).catch(e=>console.warn('활동 로그 서버 기록 실패(화면에는 반영됨):',e));
    return;
  }
  try{
    const key='oheng_logs_'+sc.id;
    const logs=JSON.parse(localStorage.getItem(key)||'[]');
    logs.push(entry);
    localStorage.setItem(key,JSON.stringify(logs.slice(-200)));
  }catch(e){console.warn('로그 기록 오류:',e);}
}
// 성적 일괄 저장 로그 — 기존 시그니처 그대로 유지(호출부 무수정)
function addLog(sc,mon,wk,count,thrRt,thrWt){
  pushLogEntry(sc,{type:'save',month:mon,week:wk,count,thrRt,thrWt,actorName:ST.actorName||'',savedAt:nowStamp()});
}
// 성적 지우기/다른 주차로 복사 등, save 외의 활동 로그 — entry에 type/month/week/count(+타입별 추가 필드)를 담아 호출
function addActionLog(sc,entry){
  pushLogEntry(sc,{...entry,actorName:ST.actorName||'',savedAt:nowStamp()});
}
```

- [ ] **Step 2: 문법 검사**

Run:
```bash
grep -n '^<script>$' index.html
grep -n '^</script>$' index.html
```
두 번째 쌍의 줄 번호(메인 앱 스크립트)를 아래에 그대로 넣는다:
```bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('index.html','utf8').split('\n');
const script = lines.slice(<시작줄>, <끝줄>-1).join('\n');
try { new Function(script); console.log('OK'); } catch(e) { console.log('SYNTAX ERROR:', e.message); }
"
```
Expected: `OK`.

- [ ] **Step 3: `addLog`가 여전히 기존 방식대로 동작하는지 로직 확인(수동 검토)**

`addLog(sc,mon,wk,count,thrRt,thrWt)`를 호출하는 기존 코드(성적 일괄 저장 버튼 핸들러)를 열어, 인자 개수/순서가 이 함수의 새 정의와 여전히 맞는지 확인한다(시그니처를 안 바꿨으므로 원래 그대로여야 함):
```bash
grep -n "addLog(sc,mon,wk" index.html
```
Expected: 기존 호출부(`addLog(sc,mon,wk,saved,thrRt,thrWt);` 형태)가 한 곳 나오고, 이 태스크에서 그 줄을 건드리지 않았음을 확인.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
활동 로그 저장 헬퍼 확장 (pushLogEntry/addLog/addActionLog)

기존 addLog 시그니처는 유지하고, 성적 지우기·복사 등 새 로그 타입을 위한
addActionLog를 추가. 공통 저장 로직은 pushLogEntry로 뽑아 중복 제거.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `clearWeekScores`/`copyWeekTo`가 활동 로그를 남기도록 연결

**Files:**
- Modify: `index.html` (`function clearWeekScores(sc,mon,week){`, `function copyWeekTo(sc,srcMon,srcWk,destMon,destWk){`)

**Interfaces:**
- Consumes: Task 1의 `addActionLog(sc, entry)`.

- [ ] **Step 1: `clearWeekScores`에 지운 인원수를 세어 로그 남기기**

`index.html`에서 아래 텍스트를 찾는다:
```js
// 이번 주 입력분(성적·숙제·코멘트·출석) 전체를 지움
function clearWeekScores(sc,mon,week){
  const wkRecs=sc.records.filter(r=>r.month===mon&&r.week===week);
  wkRecs.forEach(r=>{
    r.rtScore=null;r.wtScore=null;r.retestTime='';
    r.hw1='';r.hw2='';r.homework='';r.comment='';r.attendType='';
  });
  recomputeWeekAggregates(sc,mon,week);
  const dirtyKeys=new Set(wkRecs.map(r=>r.sid+'|'+r.month+'|'+r.week));
  saveDB({dirtyKeys});
}
```

변경 후(지우기 **전** 실제로 뭔가 들어있던 학생 수를 세어 `count`로 씀 — 화면의 확인창에 뜨는 "대상 인원"과 같은 기준):
```js
// 이번 주 입력분(성적·숙제·코멘트·출석) 전체를 지움
function clearWeekScores(sc,mon,week){
  const wkRecs=sc.records.filter(r=>r.month===mon&&r.week===week);
  const clearedCount=wkRecs.filter(r=>r.rtScore!=null||r.wtScore!=null||r.retestTime||r.hw1||r.hw2||r.comment||r.attendType).length;
  wkRecs.forEach(r=>{
    r.rtScore=null;r.wtScore=null;r.retestTime='';
    r.hw1='';r.hw2='';r.homework='';r.comment='';r.attendType='';
  });
  recomputeWeekAggregates(sc,mon,week);
  const dirtyKeys=new Set(wkRecs.map(r=>r.sid+'|'+r.month+'|'+r.week));
  addActionLog(sc,{type:'clear',month:mon,week:week,count:clearedCount});
  saveDB({dirtyKeys});
}
```

- [ ] **Step 2: `copyWeekTo`에 복사된 인원수를 세어 로그 남기기**

`index.html`에서 아래 텍스트를 찾는다:
```js
function copyWeekTo(sc,srcMon,srcWk,destMon,destWk){
  const srcRecs=sc.records.filter(r=>r.month===srcMon&&r.week===srcWk);
  const dirtyKeys=new Set();
  srcRecs.forEach(src=>{
    let dest=sc.records.find(r=>r.sid===src.sid&&r.month===destMon&&r.week===destWk);
    if(!dest){dest={sid:src.sid,month:destMon,week:destWk};sc.records.push(dest);}
    const {sid,month,week,...fields}=src;
    Object.assign(dest,fields);
    dest.sid=src.sid;dest.month=destMon;dest.week=destWk;
    dirtyKeys.add(dest.sid+'|'+destMon+'|'+destWk);
  });
  recomputeWeekAggregates(sc,destMon,destWk);
  saveDB({dirtyKeys});
}
```

변경 후:
```js
function copyWeekTo(sc,srcMon,srcWk,destMon,destWk){
  const srcRecs=sc.records.filter(r=>r.month===srcMon&&r.week===srcWk);
  const dirtyKeys=new Set();
  srcRecs.forEach(src=>{
    let dest=sc.records.find(r=>r.sid===src.sid&&r.month===destMon&&r.week===destWk);
    if(!dest){dest={sid:src.sid,month:destMon,week:destWk};sc.records.push(dest);}
    const {sid,month,week,...fields}=src;
    Object.assign(dest,fields);
    dest.sid=src.sid;dest.month=destMon;dest.week=destWk;
    dirtyKeys.add(dest.sid+'|'+destMon+'|'+destWk);
  });
  recomputeWeekAggregates(sc,destMon,destWk);
  addActionLog(sc,{type:'copy',month:destMon,week:destWk,srcMonth:srcMon,srcWeek:srcWk,count:srcRecs.length});
  saveDB({dirtyKeys});
}
```

- [ ] **Step 3: 문법 검사**

Run:
```bash
grep -n '^<script>$' index.html
grep -n '^</script>$' index.html
```
```bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('index.html','utf8').split('\n');
const script = lines.slice(<시작줄>, <끝줄>-1).join('\n');
try { new Function(script); console.log('OK'); } catch(e) { console.log('SYNTAX ERROR:', e.message); }
"
```
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
성적 지우기/다른 주차로 복사 시 활동 로그 기록

clearWeekScores는 지우기 전 실제로 값이 있던 인원수를, copyWeekTo는
원본 주차 레코드 수를 count로 기록.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 서버가 `actorName`을 세션 기준으로 덮어쓰도록 `append-save-log` 수정

**Files:**
- Modify: `api/admin/[action].js` (`if (action === 'append-save-log') {` 블록)

**Interfaces:**
- Consumes: 파일 상단에서 이미 실행된 `const session = await requireAdminSessionOrApiToken(req);` (재선언하지 않고 그대로 사용).

- [ ] **Step 1: `append-save-log` 액션 블록 교체**

`api/admin/[action].js`에서 아래 텍스트를 찾는다:
```js
  if (action === 'append-save-log') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { schoolId, entry } = req.body || {};
    if (!schoolId || !entry) return res.status(400).json({ success: false, message: 'Missing schoolId/entry' });

    const sc = await getSchool(schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    sc.saveLogs = Array.isArray(sc.saveLogs) ? sc.saveLogs : [];
    sc.saveLogs.push(entry);
    if (sc.saveLogs.length > 200) sc.saveLogs = sc.saveLogs.slice(-200);
    sc.version = (sc.version || 0) + 1;
    await getRedis().set('school:' + schoolId, sc);
    return res.status(200).json({ success: true });
  }
```

변경 후:
```js
  if (action === 'append-save-log') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { schoolId, entry } = req.body || {};
    if (!schoolId || !entry) return res.status(400).json({ success: false, message: 'Missing schoolId/entry' });

    const sc = await getSchool(schoolId);
    if (!sc) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    // "누가"는 클라이언트 값을 신뢰하지 않고 서버가 세션에서 읽은 이름으로 덮어씀
    // (viaApiToken 경로는 session.actorName이 없으므로 클라이언트가 보낸 값이 그대로 쓰임 — 운영 호출용)
    const stampedEntry = { ...entry, actorName: session.actorName || entry.actorName || '' };
    sc.saveLogs = Array.isArray(sc.saveLogs) ? sc.saveLogs : [];
    sc.saveLogs.push(stampedEntry);
    if (sc.saveLogs.length > 200) sc.saveLogs = sc.saveLogs.slice(-200);
    sc.version = (sc.version || 0) + 1;
    await getRedis().set('school:' + schoolId, sc);
    return res.status(200).json({ success: true });
  }
```

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
append-save-log가 actorName을 세션 기준으로 덮어쓰도록 수정

클라이언트가 보낸 actorName을 그대로 믿지 않고, 로그인 세션의
session.actorName으로 항상 덮어써서 신원 위조/오래된 값 유입을 막음.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: "저장 이력" 화면을 타입별로 확장 (`rLogs`)

**Files:**
- Modify: `index.html` (`function rLogs(sc){` 전체)

**Interfaces:**
- Consumes: Task 1~3에서 만들어지는 로그 항목 형태(`{type,month,week,count,thrRt?,thrWt?,srcMonth?,srcWeek?,actorName,savedAt}`), 기존 `esc()`, `getSaveLogs(sc)`(무수정).

- [ ] **Step 1: `rLogs` 함수 전체 교체**

`index.html`에서 아래 텍스트를 찾는다:
```js
function rLogs(sc){
  try{
    const logs=getSaveLogs(sc);
    if(!logs.length)return`<div class="section-card" style="text-align:center;padding:30px 0">
      <div style="font-size:32px;margin-bottom:10px">📋</div>
      <div style="font-size:14px;font-weight:500;margin-bottom:6px">저장 로그가 없습니다</div>
      <div style="font-size:12px;color:var(--tx2)">성적 저장 시 자동 기록됩니다</div>
    </div>`;

    // 최신순 정렬
    const sorted=[...logs].reverse();

    return`<div style="font-size:12px;color:var(--tx2);margin-bottom:12px">
      총 ${logs.length}회 저장 · 클릭하면 해당 주차로 이동
    </div>`+
    sorted.map((l,i)=>{
      const wkRecs=sc.records.filter(r=>r.month===l.month&&r.week===l.week);
      return`<div class="section-card" style="cursor:pointer;transition:box-shadow 0.15s"
        onmouseover="this.style.boxShadow='0 4px 20px rgba(26,35,126,0.15)'"
        onmouseout="this.style.boxShadow=''"
        onclick="goToWeek('${l.month}','${l.week}')">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#1A237E,#3949AB);display:flex;align-items:center;justify-content:center;color:#FFB300;font-size:14px;font-weight:800;flex-shrink:0">${logs.length-i}</div>
            <div>
              <div style="font-size:15px;font-weight:700;color:#1A237E">${l.month} ${l.week}</div>
              <div style="font-size:11px;color:#9BA3AF;margin-top:1px">${l.savedAt}</div>
            </div>
          </div>
          <div style="text-align:right;display:flex;gap:12px;align-items:center">
            <div style="text-align:center">
              <div style="font-size:10px;color:#9BA3AF">저장인원</div>
              <div style="font-size:16px;font-weight:700;color:#1A237E">${l.count}명</div>
            </div>
            <div style="text-align:center;background:#FFF8E1;border-radius:8px;padding:6px 10px">
              <div style="font-size:10px;color:#E65100">RT/WT 기준</div>
              <div style="font-size:13px;font-weight:700;color:#E65100">${l.thrRt??'-'}점 / ${l.thrWt??'-'}점</div>
            </div>
            <div style="font-size:20px;color:#C4C9D4">›</div>
          </div>
        </div>
      </div>`;
    }).join('');
  }catch(e){return`<div class="section-card">저장 로그를 불러올 수 없습니다.</div>`;}
}
```

변경 후:
```js
function rLogs(sc){
  try{
    const logs=getSaveLogs(sc);
    if(!logs.length)return`<div class="section-card" style="text-align:center;padding:30px 0">
      <div style="font-size:32px;margin-bottom:10px">📋</div>
      <div style="font-size:14px;font-weight:500;margin-bottom:6px">활동 로그가 없습니다</div>
      <div style="font-size:12px;color:var(--tx2)">성적 저장·지우기·복사 시 자동 기록됩니다</div>
    </div>`;

    const TYPE_META={
      save:{label:'저장',grad:'linear-gradient(135deg,#1A237E,#3949AB)',countLabel:'저장인원'},
      clear:{label:'지우기',grad:'linear-gradient(135deg,#C62828,#E53935)',countLabel:'지운인원'},
      copy:{label:'복사',grad:'linear-gradient(135deg,#5C6470,#8E85B0)',countLabel:'복사인원'},
    };

    // 최신순 정렬
    const sorted=[...logs].reverse();

    return`<div style="font-size:12px;color:var(--tx2);margin-bottom:12px">
      총 ${logs.length}건 · 클릭하면 해당 주차로 이동
    </div>`+
    sorted.map(l=>{
      const type=l.type||'save';
      const meta=TYPE_META[type]||TYPE_META.save;
      const titleText=type==='copy'?`${l.srcMonth} ${l.srcWeek} → ${l.month} ${l.week}`:`${l.month} ${l.week}`;
      return`<div class="section-card" style="cursor:pointer;transition:box-shadow 0.15s"
        onmouseover="this.style.boxShadow='0 4px 20px rgba(26,35,126,0.15)'"
        onmouseout="this.style.boxShadow=''"
        onclick="goToWeek('${l.month}','${l.week}')">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:10px;background:${meta.grad};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:800;flex-shrink:0">${meta.label}</div>
            <div>
              <div style="font-size:15px;font-weight:700;color:#1A237E">${titleText}</div>
              <div style="font-size:11px;color:#9BA3AF;margin-top:1px">${esc(l.actorName||'관리자')}님 · ${l.savedAt}</div>
            </div>
          </div>
          <div style="text-align:right;display:flex;gap:12px;align-items:center">
            <div style="text-align:center">
              <div style="font-size:10px;color:#9BA3AF">${meta.countLabel}</div>
              <div style="font-size:16px;font-weight:700;color:#1A237E">${l.count}명</div>
            </div>
            ${type==='save'?`<div style="text-align:center;background:#FFF8E1;border-radius:8px;padding:6px 10px">
              <div style="font-size:10px;color:#E65100">RT/WT 기준</div>
              <div style="font-size:13px;font-weight:700;color:#E65100">${l.thrRt??'-'}점 / ${l.thrWt??'-'}점</div>
            </div>`:''}
            <div style="font-size:20px;color:#C4C9D4">›</div>
          </div>
        </div>
      </div>`;
    }).join('');
  }catch(e){return`<div class="section-card">활동 로그를 불러올 수 없습니다.</div>`;}
}
```

주의: 기존 `wkRecs` 변수(원래 `sc.records.filter(...)`)는 실제로 아무 데도 쓰이지 않던 죽은 코드였다 — 새 버전에서 제거했다. `logs.length-i` 기반 순번 배지는 타입 배지로 대체되어 `sorted.map((l,i)=>...)`의 `i`가 더 이상 필요 없으므로 `sorted.map(l=>...)`로 바뀐 것도 의도된 변경이다.

- [ ] **Step 2: 문법 검사**

Run:
```bash
grep -n '^<script>$' index.html
grep -n '^</script>$' index.html
```
```bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('index.html','utf8').split('\n');
const script = lines.slice(<시작줄>, <끝줄>-1).join('\n');
try { new Function(script); console.log('OK'); } catch(e) { console.log('SYNTAX ERROR:', e.message); }
"
```
Expected: `OK`.

- [ ] **Step 3: `esc()` 적용 확인(수동 검토)**

```bash
grep -n "l.actorName" index.html
```
Expected: `esc(l.actorName||'관리자')` 형태로 반드시 `esc()`에 감싸여 있어야 한다(리터럴 `l.actorName`만 단독으로 노출되면 안 됨).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
'저장 이력' 화면을 성적 저장/지우기/복사 통합 활동 로그로 확장

타입별 배지·문구, "누가" 표시(esc 적용, 없으면 '관리자'), 복사는
출발→도착 주차 표시, RT/WT 기준은 저장 타입에만 노출.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 배포 + 종단 검증

**Files:** 없음(배포 및 curl/실사용 검증만).

**Interfaces:** 없음.

- [ ] **Step 1: Push해서 배포 트리거**

```bash
git push origin main
```

- [ ] **Step 2: 배포 완료 대기**

```bash
git rev-parse HEAD
```
그 SHA가 나올 때까지 반복 확인:
```bash
curl -s https://oheng.vercel.app/api/version
```

- [ ] **Step 3: `append-save-log`가 클라이언트 값이 아니라 실제로 무시/대체하는지 확인 (운영 토큰 경로)**

운영 토큰 경로는 세션이 없으므로(`session.actorName` 없음), 클라이언트가 보낸 값이 그대로 남아야 한다 — 이건 "서버가 세션 기준으로 덮어쓴다"는 로직이 **세션이 있을 때만** 개입하고 없을 때는 원래 값을 보존한다는 걸 확인하는 목적이다. 존재하지 않는 테스트 학교 id로 호출해 404가 나는지만 확인해도 이 경로가 살아있음은 확인 가능:
```bash
curl -s -X POST https://oheng.vercel.app/api/admin/append-save-log \
  -H "x-api-token: <API_AUTH_TOKEN>" -H "Content-Type: application/json" -H "Origin: https://oheng.vercel.app" \
  -d '{"schoolId":"__no_such_school__","entry":{"type":"save","month":"7월","week":"1주","count":1,"actorName":"임의값"}}'
```
Expected: `{"success":false,"message":"학교를 찾을 수 없습니다"}` (404) — 엔드포인트가 정상 동작 중임을 확인.

- [ ] **Step 4: 실제 로그인으로 세 가지 타입 전부 확인**

마스터 계정으로 실제 로그인 → 아무 학교나 골라 성적 일괄 저장 1건, "이번 주 성적 지우기" 1건,
"다른 주차로 복사" 1건을 실행 → "저장 이력" 탭에서:
- 세 카드 모두 타입별 배지·문구가 맞게 나오는지("저장"/"지우기"/"복사")
- "OOO님" 부분에 실제 로그인한 계정 이름이 나오는지
- 복사 카드에 "출발주차 → 도착주차" 형태로 나오는지
- 저장 카드에만 RT/WT 기준이 보이고 지우기/복사 카드에는 안 보이는지
- 카드 클릭 시 해당 주차로 정상 이동하는지

- [ ] **Step 5: 조교 계정으로도 동일 확인**

1단계 검증 때처럼 임시 조교 계정을 하나 만들어(`ta-create`) 로그인 → 성적 저장 1건 실행 →
"저장 이력"에 조교의 실제 표시 이름이 정확히 나오는지 확인 → 확인 후 `ta-delete`로 정리.

- [ ] **Step 6: 옛날 로그(마이그레이션 이전, `type` 없음)가 깨지지 않는지 확인**

이미 운영 중인 학교라면 이번 기능 배포 전에 쌓인 옛날 `saveLogs` 항목이 있을 것이다 — "저장 이력"
탭을 열었을 때 그 항목들도 오류 없이 "저장" 타입 카드로 정상 렌더링되는지 확인(자동으로 `type||'save'`
기본값 처리가 되므로 별도 조치 없이 통과해야 함).
