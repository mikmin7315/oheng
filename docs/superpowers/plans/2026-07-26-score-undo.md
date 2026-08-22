# 성적 되돌리기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 성적 저장/지우기/복사 각각이 실행 직전 스냅샷을 로그에 함께 남기고, "저장 이력" 탭에서 그 스냅샷으로 되돌릴 수 있게 한다.

**Architecture:** 세 행동 모두 레코드를 mutate하기 직전에 영향받는 레코드들의 "입력 필드"만 스냅샷으로 떠서 로그 항목에 실어 보낸다(계산 필드는 되돌린 뒤 `recomputeWeekAggregates`로 다시 계산). 되돌리기는 그 스냅샷을 복원하고 같은 주차를 재계산한 뒤, 되돌리기 자체도 새 로그 항목(`type:'undo'`)으로 남긴다. 새 서버 API는 만들지 않는다 — 기존 `append-save-log`로 모든 로그 타입을 처리하고, "이미 되돌려졌는가"는 저장하지 않고 매번 로그 배열 전체에서 계산한다.

**Tech Stack:** Vercel serverless functions(변경 없음, 이 계획은 `index.html` 클라이언트 코드만 수정), 순수 HTML/CSS/JS 단일 페이지, 테스트 프레임워크 없음 — `node -e` 로컬 로직/구문 검증 + 배포 후 실제 로그인 검증.

## Global Constraints

- 새 Redis 필드/새 서버리스 함수를 만들지 않는다 — 기존 `sc.saveLogs`와 기존 `append-save-log` 액션을 그대로 쓴다.
- 스냅샷에는 "입력 필드"만 담는다: `thrRt, thrWt, rtSkip, rtScore, wtSkip, wtScore, hw1, hw2, homework, hwName1, hwName2, retestTime, comment, attendType`. "계산 필드"(`totalScore, rvRank, wtRank, totalRank, rtPass, wtPass, rvAvg, wtAvg, totalAvg`)는 스냅샷에 담지 않고 되돌린 뒤 `recomputeWeekAggregates`로 다시 계산한다.
- 스냅샷 범위는 로그의 `count`(화면 표시용, "의미 있게 값이 있던 인원수")가 아니라 그 행동이 **실제로 mutate하는 레코드 전체**를 대상으로 한다.
- 로그 항목은 추가 전용(append-only)으로 유지한다 — 기존 항목을 나중에 수정(`undone:true` 등)하지 않는다. "이미 되돌려졌는가"는 `logs.some(e=>e.type==='undo'&&e.undoneLogId===entry.id)`로 매번 계산한다.
- 되돌리기(`type:'undo'`) 항목 자체는 스냅샷을 갖지 않는다 — 다시 되돌릴 수 없다(YAGNI, redo 없음).
- 스냅샷이 없는 로그 항목(이 기능 배포 전 데이터)에는 되돌리기 버튼을 표시하지 않는다.
- 스펙 문서: `docs/superpowers/specs/2026-07-26-score-undo-design.md` (이 계획은 그 문서의 승인된 설계를 그대로 구현한다 — 상충되면 스펙이 우선).

---

### Task 1: 스냅샷 헬퍼 + 로그 항목 id + `undoActionLog` 추가

**Files:**
- Modify: `index.html` (`clearWeekScores` 함수 바로 앞, `pushLogEntry` 함수)

**Interfaces:**
- Produces: `RECORD_INPUT_FIELDS`(배열 상수), `snapshotRecord(rec)`(레코드 객체 또는 `null` → 입력 필드만 담은 얕은 복사 객체, `rec`가 없으면 빈 객체 없이 그대로 처리는 호출부 책임), `undoActionLog(sc, entry)`(entry.snapshot으로 되돌리고 재계산·저장·로그까지 전부 수행).
- Consumes: 기존 `recomputeWeekAggregates(sc,mon,week)`, `addActionLog(sc,entry)`, `saveDB(intent)`(전부 이미 존재, 변경 없음).

- [ ] **Step 1: `clearWeekScores` 함수 바로 앞에 스냅샷 헬퍼와 `undoActionLog` 삽입**

`index.html`에서 아래 텍스트를 찾는다:
```js
// 이번 주 입력분(성적·숙제·코멘트·출석) 전체를 지움
function clearWeekScores(sc,mon,week){
```

그 앞(빈 줄 유지)에 아래 블록을 삽입한다:
```js
// 되돌리기 스냅샷에 담는 "입력 필드" — 등수/평균 같은 계산 필드는 여기 없음(되돌린 뒤 recomputeWeekAggregates가 다시 채움)
const RECORD_INPUT_FIELDS=['thrRt','thrWt','rtSkip','rtScore','wtSkip','wtScore','hw1','hw2','homework','hwName1','hwName2','retestTime','comment','attendType'];
function snapshotRecord(rec){
  const fields={};
  RECORD_INPUT_FIELDS.forEach(f=>{fields[f]=rec[f]??null;});
  return fields;
}
// entry.snapshot으로 그 행동을 되돌림 — wasNew면 레코드 자체를 삭제, 아니면 입력 필드를 복원 후 그 주차 전체를 재계산.
// 되돌리기 자체도 새 로그(type:'undo')로 남기되, 그 항목은 스냅샷을 갖지 않음(다시 되돌릴 수 없음).
function undoActionLog(sc,entry){
  const {month,week,snapshot}=entry;
  if(!Array.isArray(snapshot)||!snapshot.length)return;
  snapshot.forEach(snap=>{
    const idx=sc.records.findIndex(r=>r.sid===snap.sid&&r.month===month&&r.week===week);
    if(snap.wasNew){
      if(idx>=0)sc.records.splice(idx,1);
    }else if(idx>=0){
      Object.assign(sc.records[idx],snap.fields);
    }else{
      sc.records.push({sid:snap.sid,month,week,...snap.fields});
    }
  });
  recomputeWeekAggregates(sc,month,week);
  const dirtyKeys=new Set(snapshot.map(s=>s.sid+'|'+month+'|'+week));
  addActionLog(sc,{type:'undo',month,week,count:snapshot.length,undoneLogId:entry.id});
  saveDB({dirtyKeys});
}

// 이번 주 입력분(성적·숙제·코멘트·출석) 전체를 지움
function clearWeekScores(sc,mon,week){
```

- [ ] **Step 2: `pushLogEntry`가 모든 로그 항목에 고유 `id`를 채우도록 수정**

`index.html`에서 아래 텍스트를 찾는다:
```js
// 활동 로그 저장 공통 로직 — entry는 이미 완성된 로그 항목(actorName/savedAt 포함)
function pushLogEntry(sc,entry){
  if(ST.serverAdminSession){
```

변경 후:
```js
// 활동 로그 저장 공통 로직 — entry는 이미 완성된 로그 항목(actorName/savedAt 포함)
function pushLogEntry(sc,entry){
  entry.id=(crypto.randomUUID?crypto.randomUUID():(Date.now()+'-'+Math.random().toString(36).slice(2,10)));
  if(ST.serverAdminSession){
```

(id는 클라이언트에서 생성해 서버로 그대로 전달되고, 서버의 `append-save-log`는 `{...entry, actorName:...}`로 spread하므로 id도 그대로 저장된다 — 서버 쪽은 이 태스크에서 건드리지 않는다.)

- [ ] **Step 3: 문법 검사**

Run:
```bash
grep -n '^<script>$' index.html
grep -n '^</script>$' index.html
```
두 번째 쌍의 줄 번호를 아래에 넣는다(관례: `slice(rawStartLine, rawEndLine-1)`, 시작줄은 grep 결과 그대로):
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
되돌리기 핵심 로직 추가 (스냅샷 헬퍼 + undoActionLog + 로그 id)

RECORD_INPUT_FIELDS/snapshotRecord로 "입력 필드"만 스냅샷에 담고,
undoActionLog가 스냅샷 복원 → 재계산 → 저장 → undo 로그 기록까지 처리.
pushLogEntry가 모든 로그 항목에 고유 id를 채우도록 함(동시 편집 안전).
아직 clearWeekScores/copyWeekTo/성적 저장은 스냅샷을 만들어 넘기지 않음(다음 태스크).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `clearWeekScores`/`copyWeekTo`가 스냅샷을 만들어 로그에 실어 보내도록 수정

**Files:**
- Modify: `index.html` (`function clearWeekScores(sc,mon,week){`, `function copyWeekTo(sc,srcMon,srcWk,destMon,destWk){`)

**Interfaces:**
- Consumes: Task 1의 `snapshotRecord(rec)`.

- [ ] **Step 1: `clearWeekScores`에 지우기 전 스냅샷 추가**

`index.html`에서 아래 텍스트를 찾는다:
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

변경 후(스냅샷은 `clearedCount` 필터링 **전**의 `wkRecs` 전체를 대상으로 함 — count와 스냅샷 범위가 다를 수 있다는 스펙의 명시적 결정):
```js
// 이번 주 입력분(성적·숙제·코멘트·출석) 전체를 지움
function clearWeekScores(sc,mon,week){
  const wkRecs=sc.records.filter(r=>r.month===mon&&r.week===week);
  const clearedCount=wkRecs.filter(r=>r.rtScore!=null||r.wtScore!=null||r.retestTime||r.hw1||r.hw2||r.comment||r.attendType).length;
  const snapshot=wkRecs.map(r=>({sid:r.sid,wasNew:false,fields:snapshotRecord(r)}));
  wkRecs.forEach(r=>{
    r.rtScore=null;r.wtScore=null;r.retestTime='';
    r.hw1='';r.hw2='';r.homework='';r.comment='';r.attendType='';
  });
  recomputeWeekAggregates(sc,mon,week);
  const dirtyKeys=new Set(wkRecs.map(r=>r.sid+'|'+r.month+'|'+r.week));
  addActionLog(sc,{type:'clear',month:mon,week:week,count:clearedCount,snapshot});
  saveDB({dirtyKeys});
}
```

- [ ] **Step 2: `copyWeekTo`에 덮어쓰기 전 스냅샷 추가**

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
  addActionLog(sc,{type:'copy',month:destMon,week:destWk,srcMonth:srcMon,srcWeek:srcWk,count:srcRecs.length});
  saveDB({dirtyKeys});
}
```

변경 후(스냅샷은 대상 레코드를 `Object.assign`으로 덮어쓰기 **전**에 떠야 한다 — 순서가 중요):
```js
function copyWeekTo(sc,srcMon,srcWk,destMon,destWk){
  const srcRecs=sc.records.filter(r=>r.month===srcMon&&r.week===srcWk);
  const dirtyKeys=new Set();
  const snapshot=[];
  srcRecs.forEach(src=>{
    let dest=sc.records.find(r=>r.sid===src.sid&&r.month===destMon&&r.week===destWk);
    const wasNew=!dest;
    if(!dest){dest={sid:src.sid,month:destMon,week:destWk};sc.records.push(dest);}
    snapshot.push({sid:src.sid,wasNew,fields:wasNew?{}:snapshotRecord(dest)});
    const {sid,month,week,...fields}=src;
    Object.assign(dest,fields);
    dest.sid=src.sid;dest.month=destMon;dest.week=destWk;
    dirtyKeys.add(dest.sid+'|'+destMon+'|'+destWk);
  });
  recomputeWeekAggregates(sc,destMon,destWk);
  addActionLog(sc,{type:'copy',month:destMon,week:destWk,srcMonth:srcMon,srcWeek:srcWk,count:srcRecs.length,snapshot});
  saveDB({dirtyKeys});
}
```

주의: `snapshot.push(...)`가 `Object.assign(dest,fields)`보다 반드시 먼저 실행돼야 한다(위 코드 순서 그대로) — 그렇지 않으면 이미 덮어써진 값을 스냅샷으로 뜨게 되어 되돌리기가 무의미해진다.

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
성적 지우기/다른 주차로 복사가 되돌리기용 스냅샷을 로그에 남기도록 수정

clearWeekScores는 그 주차 레코드 전체(clearedCount 필터링 전)를,
copyWeekTo는 덮어쓰기 직전 대상 레코드 상태를 스냅샷으로 기록.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 성적 일괄 저장이 스냅샷을 만들어 로그에 실어 보내도록 수정

**Files:**
- Modify: `index.html` (`function addLog(sc,mon,wk,count,thrRt,thrWt){`, `btn-save` 클릭 핸들러 내부 `rows.forEach` 및 `addLog` 호출부)

**Interfaces:**
- Consumes: Task 1의 `snapshotRecord(rec)`.
- Produces: `addLog(sc,mon,wk,count,thrRt,thrWt,snapshot)` — 7번째 인자 `snapshot`은 선택값(옵셔널). 기존처럼 6개 인자로만 호출해도 그대로 동작(하위호환) — 이 태스크에서 수정하는 유일한 호출부(`btn-save` 핸들러)만 7번째 인자를 넘기게 된다.

- [ ] **Step 1: `addLog`가 선택적 `snapshot` 인자를 받도록 확장**

`index.html`에서 아래 텍스트를 찾는다:
```js
// 성적 일괄 저장 로그 — 기존 시그니처 그대로 유지(호출부 무수정)
function addLog(sc,mon,wk,count,thrRt,thrWt){
  pushLogEntry(sc,{type:'save',month:mon,week:wk,count,thrRt,thrWt,actorName:ST.actorName||'',savedAt:nowStamp()});
}
```

변경 후:
```js
// 성적 일괄 저장 로그 — snapshot은 선택값(안 넘기면 기존과 동일하게 동작, 하위호환)
function addLog(sc,mon,wk,count,thrRt,thrWt,snapshot){
  pushLogEntry(sc,{type:'save',month:mon,week:wk,count,thrRt,thrWt,actorName:ST.actorName||'',savedAt:nowStamp(),...(snapshot?{snapshot}:{})});
}
```

- [ ] **Step 2: `btn-save` 핸들러의 `rows.forEach` 안에서 덮어쓰기 전 스냅샷을 모으고, `addLog` 호출에 넘기기**

`index.html`에서 아래 텍스트를 찾는다:
```js
    let saved=0;const savedSids=[];
    rows.forEach(r=>{
      const sid=r.dataset.sid;if(!sid)return;
      const existingIdx=sc.records.findIndex(x=>x.sid===sid&&x.month===mon&&x.week===wk);
      const existingComment=existingIdx>=0?(sc.records[existingIdx].comment||''):'';
      const rsk=r.dataset.rtskip==='1';const wsk=r.dataset.wtskip==='1';
      const rtv=parseFloat(r.querySelector('.inp-rt').value);const wtv=parseFloat(r.querySelector('.inp-wt').value);
      const rec={sid,month:mon,week:wk,thrRt,thrWt,
        rtSkip:rsk,rtScore:rsk?null:(isNaN(rtv)?null:rtv),rvRank:rsk?null:rtRankMap[sid]??null,rvAvg:rsk?null:rvAvg,
        rtPass:rsk?null:(thrRt===null||isNaN(rtv)?null:rtv>=thrRt),evalScore:null,
        wtSkip:wsk,wtScore:wsk?null:(isNaN(wtv)?null:wtv),wtRank:wsk?null:wtRankMap[sid]??null,wtAvg:wsk?null:wtAvg,
        wtPass:wsk?false:(thrWt===null||isNaN(wtv)?null:wtv>=thrWt),
        totalScore:totValMap[sid]??null,totalRank:totRankMap[sid]??null,totalAvg:totAvg,
        past6:null,past9:null,
        hw1:r.querySelector('.inp-hw1')?.value||'',
        hw2:r.querySelector('.inp-hw2')?.value||'',
        homework:r.querySelector('.inp-hw1')?.value||'',
        hwName1:(()=>{const _k=mon+'_'+wk;return sc.hwNames&&sc.hwNames[_k]?sc.hwNames[_k].hw1:sc.hw1||'숙제1';})(),
        hwName2:(()=>{const _k=mon+'_'+wk;return sc.hwNames&&sc.hwNames[_k]?sc.hwNames[_k].hw2:sc.hw2||'숙제2';})(),
        retestTime:r.querySelector('.inp-rt2').value,comment:existingComment};
      if(existingIdx>=0)sc.records[existingIdx]=rec;else sc.records.push(rec);saved++;savedSids.push(sid);
    });
    addLog(sc,mon,wk,saved,thrRt,thrWt);
```

변경 후(스냅샷은 `sc.records[existingIdx]=rec`로 덮어쓰기 **전**의 기존 레코드를 대상으로 함):
```js
    let saved=0;const savedSids=[];const snapshot=[];
    rows.forEach(r=>{
      const sid=r.dataset.sid;if(!sid)return;
      const existingIdx=sc.records.findIndex(x=>x.sid===sid&&x.month===mon&&x.week===wk);
      const existingComment=existingIdx>=0?(sc.records[existingIdx].comment||''):'';
      const wasNew=existingIdx<0;
      snapshot.push({sid,wasNew,fields:wasNew?{}:snapshotRecord(sc.records[existingIdx])});
      const rsk=r.dataset.rtskip==='1';const wsk=r.dataset.wtskip==='1';
      const rtv=parseFloat(r.querySelector('.inp-rt').value);const wtv=parseFloat(r.querySelector('.inp-wt').value);
      const rec={sid,month:mon,week:wk,thrRt,thrWt,
        rtSkip:rsk,rtScore:rsk?null:(isNaN(rtv)?null:rtv),rvRank:rsk?null:rtRankMap[sid]??null,rvAvg:rsk?null:rvAvg,
        rtPass:rsk?null:(thrRt===null||isNaN(rtv)?null:rtv>=thrRt),evalScore:null,
        wtSkip:wsk,wtScore:wsk?null:(isNaN(wtv)?null:wtv),wtRank:wsk?null:wtRankMap[sid]??null,wtAvg:wsk?null:wtAvg,
        wtPass:wsk?false:(thrWt===null||isNaN(wtv)?null:wtv>=thrWt),
        totalScore:totValMap[sid]??null,totalRank:totRankMap[sid]??null,totalAvg:totAvg,
        past6:null,past9:null,
        hw1:r.querySelector('.inp-hw1')?.value||'',
        hw2:r.querySelector('.inp-hw2')?.value||'',
        homework:r.querySelector('.inp-hw1')?.value||'',
        hwName1:(()=>{const _k=mon+'_'+wk;return sc.hwNames&&sc.hwNames[_k]?sc.hwNames[_k].hw1:sc.hw1||'숙제1';})(),
        hwName2:(()=>{const _k=mon+'_'+wk;return sc.hwNames&&sc.hwNames[_k]?sc.hwNames[_k].hw2:sc.hw2||'숙제2';})(),
        retestTime:r.querySelector('.inp-rt2').value,comment:existingComment};
      if(existingIdx>=0)sc.records[existingIdx]=rec;else sc.records.push(rec);saved++;savedSids.push(sid);
    });
    addLog(sc,mon,wk,saved,thrRt,thrWt,snapshot);
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
성적 일괄 저장이 되돌리기용 스냅샷을 로그에 남기도록 수정

addLog에 선택적 snapshot 인자 추가(하위호환), btn-save 핸들러가
덮어쓰기 전 각 학생의 기존 레코드를 스냅샷으로 모아 함께 전달.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: "저장 이력" 화면에 되돌리기 버튼 추가

**Files:**
- Modify: `index.html` (`function rLogs(sc){` 카드 렌더링 부분, `bAdmin()`의 `if(ST.atab==='logs'){return;}` 블록)

**Interfaces:**
- Consumes: Task 1의 `undoActionLog(sc,entry)`, 각 로그 항목의 `id`/`snapshot`/`undoneLogId` 필드.

- [ ] **Step 1: `rLogs`의 카드 렌더링에 되돌리기 버튼/상태 표시 추가**

`index.html`에서 아래 텍스트를 찾는다:
```js
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
```

변경 후:
```js
    sorted.map(l=>{
      const type=l.type||'save';
      const meta=TYPE_META[type]||TYPE_META.save;
      const titleText=type==='copy'?`${l.srcMonth} ${l.srcWeek} → ${l.month} ${l.week}`:`${l.month} ${l.week}`;
      const isUndone=logs.some(e=>e.type==='undo'&&e.undoneLogId===l.id);
      const canUndo=type!=='undo'&&Array.isArray(l.snapshot)&&l.snapshot.length>0&&!isUndone;
      const footerRow=type==='undo'
        ?`<div style="border-top:1px solid #F0F1F5;margin-top:10px;padding-top:10px;font-size:11.5px;color:#8E85B0;font-weight:600">↩ 되돌리기 기록</div>`
        :canUndo
          ?`<div style="border-top:1px solid #F0F1F5;margin-top:10px;padding-top:10px">
              <button class="abtn abtn-gray" data-undo-log-id="${esc(l.id||'')}" style="padding:6px 14px;font-size:12px" onclick="event.stopPropagation()">↩ 되돌리기</button>
            </div>`
          :isUndone
            ?`<div style="border-top:1px solid #F0F1F5;margin-top:10px;padding-top:10px;font-size:11.5px;color:#9BA3AF;font-weight:600">되돌려짐</div>`
            :'';
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
        ${footerRow}
      </div>`;
    }).join('');
```

- [ ] **Step 2: `bAdmin()`에서 되돌리기 버튼 클릭 핸들러 연결**

`index.html`에서 아래 텍스트를 찾는다:
```js
  if(ST.atab==='logs'){return;}
```

변경 후:
```js
  if(ST.atab==='logs'){
    document.querySelectorAll('[data-undo-log-id]').forEach(b=>{
      b.onclick=(e)=>{
        e.stopPropagation();
        const logId=b.dataset.undoLogId;
        const entry=(sc.saveLogs||[]).find(l=>l.id===logId);
        if(!entry)return;
        const typeLabel={save:'저장',clear:'지우기',copy:'복사'}[entry.type]||entry.type;
        if(!confirm(`${entry.count}명의 ${typeLabel} 내용을 ${entry.savedAt} 상태로 되돌립니다.\n\n그 이후 이 주차에 다른 변경이 있었다면 그 변경도 함께 사라질 수 있습니다.\n\n계속하시겠습니까?`))return;
        undoActionLog(sc,entry);
        render();
      };
    });
    return;
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

- [ ] **Step 4: `esc()` 적용 확인(수동 검토)**

```bash
grep -n "data-undo-log-id" index.html
```
Expected: `data-undo-log-id="${esc(l.id||'')}"` 형태로 `esc()`에 감싸여 있어야 한다.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
'저장 이력' 화면에 되돌리기 버튼 추가

스냅샷이 있고 아직 안 되돌려진 항목에만 버튼 표시, 이미 되돌려진
항목은 "되돌려짐"으로 표시. undo 항목 자체는 되돌리기 대상이 아님을
명시. 클릭 시 확인창(다른 변경이 있었을 수 있다는 경고 포함) 후 실행.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 배포 + 종단 검증

**Files:** 없음(배포 및 실제 로그인 검증만).

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

- [ ] **Step 3: 실제 로그인으로 저장 → 되돌리기 확인**

마스터 계정으로 로그인 → 아무 학교나 골라 성적 일괄 저장 실행 → "저장 이력" 탭에서 방금 항목의
"되돌리기" 클릭 → 확인창 승인 → 저장 전 값으로 정확히 복원됐는지, 등수·반평균이 정상 재계산됐는지
확인.

- [ ] **Step 4: 지우기 → 되돌리기 확인**

값이 들어있는 주차에서 "이번 주 성적 지우기" 실행 → "저장 이력"에서 되돌리기 → 지우기 전 값(성적·
숙제·코멘트·출석 전부)이 정확히 복원되는지 확인.

- [ ] **Step 5: 복사(기존 값 있는 상태로 덮어쓰기) → 되돌리기 확인**

이미 값이 있는 주차에 "다른 주차로 복사" 실행(기존 값을 덮어씀) → 되돌리기 → 복사로 덮어써지기
전의 원래 값이 정확히 복원되는지 확인.

- [ ] **Step 6: 원래 레코드가 없던 학생 케이스 확인**

레코드가 없던 학생에게 처음 저장(또는 처음 복사)한 뒤 되돌리기 → 값이 빈 걸로 남는 게 아니라
레코드 자체가 삭제되는지 확인(성적표에 "시험 없음"으로 나오는 원래 상태와 동일한지).

- [ ] **Step 7: 중복 되돌리기 방지 확인**

방금 되돌린 항목의 카드를 다시 보고 — 버튼이 "되돌려짐"으로 바뀌어 재실행이 안 되는지 확인.
"되돌리기" 자체가 만든 `type:'undo'` 로그 항목에는 되돌리기 버튼이 없는지도 함께 확인.

- [ ] **Step 8: 조교 계정으로도 확인**

임시 조교 계정을 하나 만들어(`ta-create`) 로그인 → 성적 저장 → 되돌리기 실행 → 로그에 되돌린
사람 이름이 정확히 남는지 확인 → 확인 후 `ta-delete`로 정리.

- [ ] **Step 9: 옛날 로그(스냅샷 없음)에 되돌리기 버튼이 안 뜨는지 확인**

이번 기능 배포 전에 쌓인 로그 항목(스냅샷 없음)을 "저장 이력"에서 확인 — 되돌리기 버튼이 없고
"되돌려짐" 표시도 없이(둘 다 해당 없음) 그냥 기존처럼 표시되는지 확인.
