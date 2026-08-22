# 조교 다중 계정 시스템 — 설계

## 배경 및 문제

oheng(성적관리 PWA)는 지금 관리자 로그인이 Redis `admin:auth` 키 하나에 계정 정보 하나
(`{id, pwdHash}`)만 저장된 구조라, 조교 여러 명이 이 계정 하나를 공유해서 로그인한다.
"누가 로그인해서 뭘 했는지" 구분이 전혀 안 되고, 계정을 나눠 관리할 방법도 없다.

이 설계는 3단계로 예정된 작업의 1단계다:
1. **조교 다중 계정** (이 문서의 범위)
2. 활동 로그 (누가 언제 뭘 했는지) — 1단계의 계정 식별을 기반으로 별도 설계 예정
3. 되돌리기 — 2단계의 로그를 기반으로 별도 설계 예정

## 확정된 요구사항

1. 조교 계정도 원장님 계정처럼 전체 학교에 동일하게 접근 가능 (학교별 권한 분리 없음, 지금과 동일)
2. 조교 계정 추가·삭제·비밀번호 초기화는 "원장님 계정(마스터)"만 할 수 있음
3. 계정마다 로그인 ID 외에 표시용 이름(예: "김민지")을 별도로 저장 — 추후 로그에 이 이름이 쓰임

## 기존 코드 현황

- `api/auth/[action].js` (action='login'): `redis.get('admin:auth')`로 단일 레코드를 가져와
  `verifyPassword`로 검증 후 `createSession({role:'admin'})`. 세션에 schoolId 없음(전체 학교 접근 전제).
- `api/_lib/auth.js`: `hashPassword`/`verifyPassword`(scrypt), `createSession`/`getSession`
  (Redis, TTL 30일), `checkRateLimit`/`checkLoginRateLimit`, `requireAdminSession`,
  `requireAdminSessionOrApiToken`, `isSameOrigin` 등 이미 존재.
- `api/admin/[action].js`: `credentials`(단일 admin 계정 id/pw 변경), `migrate`(전체 데이터
  마이그레이션, `admin:auth`를 단일 객체로 새로 씀), `backup-run`(admin:auth를 포함해 GitHub에
  백업), 그 외 학교/학생 관련 액션들.
- `append-save-log` 액션: 학교별 `sc.saveLogs` 배열에 저장 이력을 append하는 전용 엔드포인트가
  이미 있음(전체 학교 blob PUT과 분리해 버전 충돌을 피함) — 2단계(활동 로그) 설계 시 참고할 패턴.
- Vercel Hobby 플랜 서버리스 함수 12개 제한 때문에 새 API 파일을 만들지 않고 기존
  `api/admin/[action].js`, `api/auth/[action].js`에 액션만 추가해왔음. 이번에도 동일하게 진행.

## 데이터 모델

Redis 키 `admin:auth`의 값을 아래 v2 구조로 전환한다.

```js
// admin:auth (v2)
{
  version: 1,           // 낙관적 락 — 계정 추가/삭제/비번변경 시 충돌 감지용
  accounts: [
    {
      id: "admin",              // 로그인 id, 항상 trim+lowercase로 저장
      name: "원장님",            // 표시용 이름
      pwdHash: "scrypt:...",
      isMaster: true,
      createdAt: "2026-07-26T...",
      updatedAt: "2026-07-26T...",
      passwordChangedAt: "2026-07-26T...",
    },
    { id: "ta1", name: "김민지", pwdHash: "...", isMaster: false, createdAt: "...", updatedAt: "...", passwordChangedAt: "..." },
  ],
}
```

기존 v1 단일 객체(`{id, pwdHash}`)는 아직 남아있을 수 있으므로, 읽는 즉시 아래 헬퍼가 v2로
정규화한다(저장은 최초 쓰기 시점에 v2로 확정).

### `api/_lib/auth.js`에 추가할 헬퍼

- `normalizeAdminAccounts(raw)` — v1(단일 객체)/v2(배열 래핑) 모두 받아 `{version, accounts:[]}` 형태로 통일. `raw`가 없으면 기본 계정 없음으로 취급.
- `getAdminAccounts()` — Redis에서 `admin:auth`를 읽어 정규화해 반환.
- `setAdminAccounts(accounts, expectedVersion)` — 쓰기 직전 현재 버전을 다시 읽어 `expectedVersion`과 비교, 다르면 예외(호출부가 재시도 또는 실패 처리). 같으면 `version+1`로 저장. (조교 계정 관리는 빈도가 낮아 낙관적 락 하나로 충분 — 별도 Redis hash/트랜잭션 도입은 이번 단계에서 하지 않음(YAGNI).)
- `findAdminAccount(accounts, id)` — 정규화된 id로 계정 하나 찾기.
- `requireMasterAdminSession(req)` — 세션이 `role==='admin' && session.isMaster===true`인지 확인한 뒤, **Redis의 현재 계정 목록에서 해당 `actorId`가 실제로 존재하고 `isMaster===true`인지 재확인**. 세션에 박제된 값만 믿지 않음(계정 삭제/권한 변경 이후에도 옛 세션이 유효할 수 있으므로). 통과하면 `{session, accounts}` 반환, 아니면 null.

## 로그인 / 세션

로그인 폼과 흐름은 그대로. `api/auth/[action].js`의 `action==='login'`에서 `role==='admin'`일 때:
1. `getAdminAccounts()`로 목록을 가져와 `findAdminAccount`로 id(정규화됨) 일치하는 계정 검색
2. `verifyPassword`로 비번 검증
3. `createSession({role:'admin', actorId: account.id, actorName: account.name, isMaster: account.isMaster})`

`api/auth/[action].js`의 `action==='session'` 응답에 `actorName`, `isMaster`를 추가 반환 —
클라이언트가 "조교 계정 관리" UI를 마스터에게만 보여줄 수 있게 함(단, 서버는 UI 노출과 무관하게
매 요청마다 권한을 다시 검사).

**하위호환**: 배포 시점에 이미 로그인되어 있던 세션(v1 시절 로그인, `isMaster` 필드 없음)은 계속
일반 관리자 기능을 쓸 수 있지만, `isMaster`가 `true`로 명시되어 있지 않으므로 마스터 전용 기능은
막힌다. 원장님은 배포 후 한 번 재로그인해야 "조교 계정" 관리 화면을 쓸 수 있다(강제 로그아웃은
하지 않음 — 재로그인 전까지는 그냥 그 UI가 안 보일 뿐).

## 권한 모델

- 조교 계정: 오늘과 동일하게 전체 학교의 성적/학생 관리 기능 전부 사용 가능.
- 계정 관리(추가/삭제/타인 비번초기화): `requireMasterAdminSession`을 통과해야만 허용.
- 본인 비밀번호 변경: 마스터/조교 구분 없이 본인 계정에 한해 가능(아래 `credentials` 참고).

## API 변경 (기존 `api/admin/[action].js`에 액션 추가, 새 서버리스 함수 없음)

모든 POST 액션은 기존 패턴대로 `isSameOrigin(req)` 체크를 유지한다.

### `credentials` (기존 액션 재정의)
"현재 로그인한 세션 본인 계정"의 정보 변경으로 의미를 좁히되, **마스터와 조교의 변경 범위가 다르다**
(요구사항 원문: 조교 본인은 비밀번호만, 아이디는 원장님만 변경 가능):
- 요청: `{currentPw, newId?, newName?, newPw?}`
- 현재 비번 검증 필수(기존과 동일)
- `session.isMaster===true`: `newId`/`newName`/`newPw` 전부 변경 가능
- `session.isMaster!==true`(조교): `newId`/`newName`이 요청에 포함되어 있으면 400 에러로 거부
  (조용히 무시하지 않음 — 클라이언트 버그나 조작 시도를 바로 드러내기 위함). `newPw`만 허용.
- `newId` 변경 시 정규화(trim+lowercase) 후 다른 계정과 중복 검사
- 성공 시 `passwordChangedAt`/`updatedAt` 갱신
- `setAdminAccounts`로 낙관적 락 저장, 버전 충돌 시 1회 재시도

### `ta-list` (신규, 마스터 전용)
- GET 또는 POST, `requireMasterAdminSession` 필수
- `pwdHash` 제외한 필드만(`id, name, isMaster, createdAt, updatedAt, passwordChangedAt`) 배열로 반환

### `ta-create` (신규, 마스터 전용)
- 요청: `{id, name, pw}`
- id 정규화 후 중복 검사, id 4자 이상 공백 없음, pw 4자 이상(기존 `credentials`와 동일 기준), name 필수
- rate limit: actorId+IP 기준 분당 10회 (`checkRateLimit` 재사용)
- `isMaster:false`로 계정 추가, `setAdminAccounts` 낙관적 락 저장

### `ta-reset-password` (신규, 마스터 전용)
- 요청: `{id, newPw?}` — `newPw` 없으면 임시 비번 랜덤 생성(기존 `reset-student-password` 패턴과 동일)
- 대상 계정의 `currentPw` 불필요(마스터 권한으로 강제 초기화)
- rate limit: actorId+IP 기준 분당 5회
- 응답에 새 비밀번호 평문을 1회 반환(화면에 표시해 전달하는 용도, 저장은 해시만)

### `ta-delete` (신규, 마스터 전용)
- 요청: `{id}`
- **불변조건**: 삭제 후에도 `isMaster===true`인 계정이 최소 1개는 남아야 함 — 마지막 마스터
  삭제 시도는 400 에러로 거부
- rate limit: actorId+IP 기준 분당 5회

### `migrate` (기존 액션 수정)
현재 `admin:auth`를 단일 객체로 새로 쓰는데, v2 구조({version, accounts:[...]})로 쓰도록 수정.
마이그레이션으로 들어온 `adminId`/`adminPwd`는 `isMaster:true` 계정 하나로 저장(기존 동작과
동일한 결과, 형태만 v2).

### `backup-run` (변경 없음, 확인만)
`admin:auth`를 그대로 백업 파일에 포함하는 기존 동작 유지. v2 구조로 바뀌어도 그대로 백업되므로
추가 수정 불필요. (백업 파일에 `pwdHash`가 포함되는 것은 기존부터 있던 특성 — 평문은 아니지만
반출 시 취급 주의는 기존과 동일하게 유지.)

## 새 UI (index.html)

관리자 설정 탭에 "조교 계정" 섹션 추가, **`isMaster===true`일 때만 렌더링**:
- 계정 목록 테이블: 이름 / 아이디 / 마스터 여부 / [비번 재설정] [삭제] 버튼
- "새 조교 추가" 폼: 이름, 아이디, 임시 비밀번호 입력 → `ta-create` 호출
- 비번 재설정: 확인창 → `ta-reset-password` 호출 → 새 임시 비번을 화면에 표시(복사 가능하게)
- 삭제: 확인창(되돌릴 수 없음 안내) → `ta-delete` 호출, 마지막 마스터 삭제 시도 시 서버 에러
  메시지를 그대로 alert로 표시

기존 "관리자 아이디/비밀번호 변경" UI는 문구만 "내 계정 정보 변경"으로 다듬고, 내부적으로
`credentials` 액션(재정의된 버전)을 그대로 호출하도록 유지. 단, `isMaster`가 아닌(조교) 세션에서는
아이디/이름 입력 필드를 아예 숨기고 비밀번호 필드만 노출 — 서버 쪽 400 거부와 별개로 UI에서도
애초에 시도할 수 없게 한다.

## 이번 단계에서 하지 않는 것 (YAGNI)

- 학교별 권한 분리 (조교마다 접근 가능한 학교를 제한하는 기능)
- 세부 role/permission 체계 (마스터/조교 2단계 외 추가 등급)
- 활동 로그, 되돌리기 (2·3단계에서 별도 설계)
- 계정별 세션 목록 조회/강제 로그아웃 UI
- 마스터 권한 위임/회수 UI (마스터 지정은 이번 단계에서 `migrate`/최초 계정 생성 시에만 결정됨)
- 조교 계정 삭제 시 기존 로그인 세션 즉시 무효화(강제 로그아웃) — 세션은 만료(TTL 30일)로
  자연 소멸에 맡김. 필요성이 제기되면 이후 별도 개선.

## 검증 계획

- 배포 후 curl + `x-api-token` 헤더로 `ta-create`/`ta-list`/`ta-reset-password`/`ta-delete`
  직접 호출해 정상 동작 확인
- 마스터 계정으로 실제 로그인 → "조교 계정" 화면 노출 확인 → 조교 계정 생성 → 새 브라우저
  프로필/시크릿창에서 조교 계정으로 로그인해 전체 학교 접근 가능하되 "조교 계정" 메뉴는 안
  보이는지 확인
- 마지막 마스터 계정 삭제 시도 시 서버가 거부하는지 확인
- 기존(마이그레이션 전) 세션을 흉내내 마스터 전용 API 호출 시 401/403으로 막히는지 확인
