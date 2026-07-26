# 성적 활동 로그 — 설계 (2단계)

## 배경 및 문제

이 프로젝트는 "조교 다중 계정"(1단계, 완료·배포됨: `docs/superpowers/specs/2026-07-26-ta-multi-account-design.md`)
으로 로그인 주체를 구분할 수 있게 됐다. 그 계기가 된 사건은 조교 여러 명이 성적을 동시에 입력하다가
"7월 3주"에 입력해야 할 걸 실수로 다른 주차에 입력한 것 — 이런 일이 다시 생겼을 때 "누가 언제 어느
주차에 뭘 했는지" 바로 확인할 방법이 없었다.

이 설계는 3단계로 예정된 작업의 2단계다:
1. 조교 다중 계정 (완료)
2. **성적 활동 로그** (이 문서의 범위)
3. 되돌리기 — 2단계의 로그를 기반으로 별도 설계 예정

## 확정된 요구사항

1. 로그 범위는 성적 관련 행동만: 성적 일괄 저장, 이번 주 성적 지우기, 다른 주차로 복사. 학생
   추가/삭제, 공지, 설정 변경 등 다른 관리자 행동은 이번 단계에서 다루지 않는다.
2. 세 가지 행동을 하나의 목록(기존 "저장 이력" 탭)에 시간순으로 통합해서 보여준다. 각 항목에
   "누가" 했는지 표시한다.

## 기존 코드 현황

- `sc.saveLogs` (Redis에 저장되는 학교별 배열) — 지금은 성적 일괄 저장 시에만
  `{month, week, count, thrRt, thrWt, savedAt}` 형태로 기록됨. "누가"는 없음(1단계 이전에는
  계정이 하나뿐이라 의미가 없었음).
- `addLog(sc,mon,wk,count,thrRt,thrWt)` (index.html) — 항목을 만들어 `sc.saveLogs`에 로컬로
  push하고, 서버 세션이 있으면 `/api/admin/append-save-log`를 별도 호출(전체 학교 blob PUT과
  분리된 전용 엔드포인트라 버전 충돌을 피함 — 성적 일괄 저장 버튼 핸들러에서 `saveDB()` 직전에 호출).
- `api/admin/[action].js`의 `append-save-log` 액션 — `{schoolId, entry}`를 받아 `sc.saveLogs`에
  push하고 200건으로 자르는 단순 read-modify-write. 파일 상단의 공통 `session = await
  requireAdminSessionOrApiToken(req)` 체크를 이미 거친 뒤 실행되므로, 이 시점에 `session.actorName`을
  사용할 수 있다(1단계에서 로그인 시 세션에 심어둠).
- `getSaveLogs(sc)` / `rLogs(sc)` (index.html) — "저장 이력" 탭 렌더링. 최신순 카드 목록, 클릭하면
  해당 주차로 이동(`goToWeek`). 각 카드는 월/주차, 시각, 저장인원, RT/WT 기준을 보여줌.
- `clearWeekScores(sc,mon,week)` / `copyWeekTo(sc,srcMon,srcWk,destMon,destWk)` (index.html,
  1단계 이전 세션에서 추가됨) — 현재 로그를 전혀 남기지 않음.
- `ST.actorName` (index.html, 1단계에서 추가) — 로그인/세션복원 시 서버 응답에서 채워짐.

## 데이터 모델

`sc.saveLogs` 배열을 그대로 재사용한다(새 Redis 필드를 만들지 않음). 항목에 `type`과 `actorName`을
추가하고, `copy` 타입에는 출발 주차 필드를 추가한다.

```js
// 'save' (기존 항목과 하위호환 — type이 없으면 'save'로 취급)
{ type:'save', month, week, count, thrRt, thrWt, actorName, savedAt }
// 'clear' (신규)
{ type:'clear', month, week, count, actorName, savedAt }
// 'copy' (신규)
{ type:'copy', month, week, srcMonth, srcWeek, count, actorName, savedAt }
```

- `count`의 의미는 타입마다 다르다: save=저장된 인원수, clear=지워진 인원수(성적·숙제·코멘트·출석 중
  하나라도 있던 학생 수), copy=복사된 인원수(원본 주차의 레코드 수).
- `thrRt`/`thrWt`는 'save'에만 있다.
- `srcMonth`/`srcWeek`는 'copy'에만 있다(`month`/`week`는 복사 **대상**(도착지) 주차).

## "누가"는 서버가 결정한다

클라이언트가 `entry`에 담아 보내는 `actorName`을 서버가 그대로 신뢰하지 않는다. 대신
`append-save-log` 액션 안에서, push하기 직전에 **서버가 세션에서 읽은 `session.actorName`으로
덮어쓴다**(`entry.actorName = session.actorName || entry.actorName || ''`). 클라이언트 조작이나
오래된 로컬 상태가 로그에 잘못된 사람을 남기는 걸 막기 위함 — 1단계에서 세션에 심어둔 신원 정보를
그대로 재사용하는 것이라 추가 인프라가 필요 없다. `viaApiToken` 경로(세션 없이 운영용 토큰으로
호출된 경우)는 `session.actorName`이 없으므로 클라이언트가 보낸 값(대개 빈 문자열)이 그대로
쓰인다 — 스크립트/운영 호출이라 사람 이름이 없는 게 자연스럽다.

## 기록 시점 (index.html)

세 곳 모두 동일한 로그 함수를 호출하도록 통일한다. 기존 `addLog`를 타입 인자를 받도록 확장한다.

- **성적 일괄 저장** (`btn-save` 핸들러, 기존 `addLog(sc,mon,wk,saved,thrRt,thrWt)` 호출부) —
  `type:'save'`로 호출(기존 시그니처 유지, 내부에서 타입 채움).
- **이번 주 성적 지우기** (`clearWeekScores`) — 지운 인원수를 세서 `type:'clear'`로 호출.
- **다른 주차로 복사** (`copyWeekTo`) — 복사된 인원수를 세서 `type:'copy'`로, `srcMonth`/`srcWeek`도
  함께 넘겨 호출.

세 곳 다 저장 자체는 이미 `saveDB()`를 통해 서버에 반영되고 있으므로(1단계에서 검증된 낙관적 락
merge 로직 그대로 사용), 로그 기록은 그 흐름에 얹는 것이지 별도의 저장 경로를 새로 만드는 게 아니다.

## 화면 (index.html, `rLogs`/`getSaveLogs`)

기존 "저장 이력" 탭을 그대로 확장한다(새 탭 안 만듦):

- 카드 왼쪽 배지를 타입별로 다르게 표시: 저장(파랑, 기존과 동일) / 지우기(빨강) / 복사(회색-보라).
- 카드에 "OOO님" 표시 추가 — `actorName`이 비어 있으면(옛날 기록, 또는 운영 토큰 호출) "관리자"로
  표시해 하위호환.
- `type==='copy'`인 카드는 "7월 3주 → 7월 4주" 형태로 출발→도착 주차를 보여준다(기존 카드는
  도착 주차만 보여주면 충분).
- RT/WT 기준 배지는 `type==='save'`일 때만 표시, 나머지 타입에서는 숨긴다(의미 없는 필드라
  혼란을 줄이기 위함).
- 정렬/클릭-이동(`goToWeek`) 동작은 타입 관계없이 기존과 동일하게 유지.

## 보관 정책

기존과 동일하게 최근 200건만 유지(`sc.saveLogs.length>200` 시 앞에서부터 자름). 세 타입이 하나의
배열을 공유하므로, 특정 타입만 유독 많이 발생해도 다른 타입 기록이 밀려날 수 있음 — 이번 단계에서는
YAGNI로 수용하고, 실제로 문제가 되면 이후 조정한다.

## 이번 단계에서 하지 않는 것 (YAGNI)

- 성적 외 다른 관리자 행동(학생 추가/삭제, 공지, 설정 변경, 조교 계정 관리 등) 로깅
- 로그 검색/필터(사람별, 기간별 등) — 시간순 전체 목록으로 충분
- 로그 자체의 되돌리기 기능(3단계에서 별도 설계)
- 로그 export/백업 별도 기능(기존 전체 백업에 이미 `sc.saveLogs`가 포함되어 있음)

## 검증 계획

- 배포 후 curl(`x-api-token`)로 `append-save-log`를 직접 호출해 `actorName`이 요청 바디의 값이
  아니라 실제로 무시/대체되는지 확인(토큰 경로라 서버가 빈 문자열로 남기는지 확인).
- 실제 마스터 계정으로 로그인 → 성적 저장/지우기/복사 각각 실행 → "저장 이력" 탭에 세 타입 모두
  올바른 배지·문구·"관리자"(로그인 이름)로 나타나는지 확인.
- 조교 계정으로 같은 세 행동을 실행 → 로그에 조교 이름이 정확히 찍히는지 확인(1단계 검증 때처럼
  테스트 조교 계정을 만들고 지워서 정리).
- 옛날 저장 로그(마이그레이션 이전 데이터, `type` 필드 없음)가 여전히 "저장" 타입으로, 오류 없이
  렌더링되는지 확인.
