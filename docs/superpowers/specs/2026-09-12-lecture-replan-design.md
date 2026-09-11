# 인강 재정비 설계 — 자동 시청기록·내 강의실·성적표 연결·게시판형 후기

## 배경

드롭박스 보안 재생(2026-09-11 배포)이 실제로 동작하는 것을 사용자가 확인한 직후, 인강 서비스 전반에 대한 요청 8건이 한꺼번에 나왔다. 개별 수정 대신 전체 기획을 재점검했고(메모: `2026-09-12-lecture-replan-memo.md`, Codex 검토 반영), 아래 7단계로 확정했다. 각 단계는 혼자서도 배포 가능한 단위다.

### 사용자 결정 (2026-09-12)
- 워터마크: 모서리에만 작게(중앙 점프 없음).
- 자동 시청 완료 기준: 실제 재생한 구간이 90% 이상(건너뛴 구간 제외, 배속 허용).
- 선생님 확인: 영상별 학생 시청 현황 **그리고** 인강/현강 체크 화면 반영 둘 다.
- 자동 기록이 들어가면 "다 봤어요" 버튼 제거(이전 결정 유지).
- 성적표 → 인강 진입: 학생 탭에 '인강' 추가, **같은 주소 안의 `/lecture.html`로 이동**(도메인별 쿠키라 주소를 바꾸면 재로그인이 필요하므로).
- 후기 게시판: 제목 목록 + 클릭 시 글 열림, 페이지 나누기, 작성 시 제목 칸.

### Codex 검토에서 반영한 것
- 출석 자동 **확정 금지** — 인강/현강 체크에는 "제안"만 띄우고 선생님이 누를 때만 저장. 손입력 값(현강·결석·직접입력)은 절대 덮어쓰지 않음.
- 자동 기록은 "수강 증명"이 아니라 "재생기 기준 기록" — 화면 표시는 "92% 시청"처럼 숫자로, 의심 신호(너무 빠른 진행)는 "확인 필요"로.
- 선생님 정정과 자동 기록의 병합 규칙을 먼저 정한다(서로 지우지 않게).
- 서버가 검증할 수 있는 것: 로그인·영상 접근권한·구간 범위·시청 시간 재계산·증가 속도. 검증할 수 없는 것: 실제로 보고 들었는지, 다른 탭을 보고 있었는지, 임시 주소를 복사해 밖에서 재생했는지.
- 영상 라우트 파일 비대화: 함수 12개 한도는 유지하되 라우터를 얇게 — 시청기록 액션 로직을 `api/_lib/watch-actions.js`로 옮기고 `api/videos/[action].js`는 넘겨주기만.
- 관리자 현황 조회 부하: 학생×영상 단위로 제한(주차별·영상별), 전체 영상×전체 학생 화면은 만들지 않음.

## 제약 (변함없음)
- Vercel Hobby 서버리스 함수 12개 — 새 `api/*.js` 파일 금지, 액션은 기존 `[action].js`에 추가, `api/_lib/*`는 자유.
- 드롭박스 원본 파일 그대로 재생(서버 영상 가공 불가), 임시 주소 4시간 고정.
- 관리자 화면(index.html)은 다크모드에서 글자색 미지정 요소가 흐려짐 — 새 요소는 반드시 글자색 지정.
- 두 화면 파일(`index.html`, `lecture.html`)은 같은 배포에서 두 도메인 모두로 서빙됨. `oheng.co.kr/`만 `lecture.html`로 클라이언트 리다이렉트되고 `/index.html`, `/lecture.html` 직접 경로는 두 도메인 모두에서 그대로 열림.

---

## 1단계 — 워터마크 축소 + 로그인 후 네비 복구 (`lecture.html`만)

**워터마크:** 글자 11px, 불투명도 30%, 재생기 네 모서리(안쪽 여백 4%) 중 한 곳. 30초마다 다른 모서리로 이동. 전체화면·가짜 전체화면에서도 그대로. 내용(이름·아이디)과 억제 안내 문구는 유지.

**네비:** 로그인 상태(`ST.mode`가 student/member)면 화면과 관계없이 상단에 **내 강의실 · 강좌 · 후기** 링크 세 개를 항상 표시. 현재 화면은 굵게. 기존 "강좌 더보기" 버튼은 이 링크로 대체. "내 강의실" = 영상 목록(list), "강좌" = 랜딩(browse), "후기" = 후기 화면(reviews). 로그아웃·이름 표시는 그대로. 비로그인 네비는 변경 없음.

## 2단계 — 성적표 ↔ 인강 왕복

- `index.html` 학생 탭 배열에 `{id:'lecture', l:'인강'}` 추가. 클릭 시 화면 전환이 아니라 `location.href='/lecture.html'`(상대 경로). 탭 표시 위치는 성적표·모의고사 다음.
- `lecture.html` 로그인 네비(1단계)에 **성적표** 링크 추가 → `location.href='/index.html'`. 학생 세션일 때만(회원은 성적표가 없음).
- 같은 도메인 이동이므로 세션 쿠키가 유지된다. `oheng.co.kr/index.html`은 루트가 아니어서 리다이렉트되지 않고 성적 앱이 뜬다(index.html 15~21행의 조건이 `pathname==='/'`).

## 3단계 — 서버: 시청 구간 저장

### 데이터 (기존 `watch:{ownerType}:{ownerId}:{videoId}` 레코드에 필드 추가)
```
progress: {
  durationSec,            // 클라이언트가 보고한 영상 길이(0 < x ≤ 21600), 서버가 범위 검사
  segments: [[s,e], ...], // 실제 재생한 구간(초, 정수). 서버가 병합·클램프·최대 400개
  watchedSec,             // 서버가 segments로 재계산한 합계 (클라이언트 값 무시)
  ratio,                  // watchedSec / durationSec, 소수 둘째 자리
  lastPositionSec,        // 이어보기 위치
  flags: [],              // 'fast_progress' 등 의심 신호
  updatedAt, firstAt
}
```
`status`에 `'auto_completed'`, `source`에 `'player'` 추가.

### 병합·우선순위 규칙 (`api/_lib/watch.js`)
- `recordProgress(ownerType, ownerId, videoId, {durationSec, segments, lastPositionSec})`:
  1. 입력 검증: durationSec 범위, segments는 `[s,e]` 숫자쌍·`0≤s<e≤durationSec`·개수 ≤ 400. 위반은 400.
  2. 기존 `progress.segments`와 합쳐 정렬·겹침 병합. `watchedSec` 재계산.
  3. 증가 속도 검사: 이전 `updatedAt` 이후 경과 시간 × 2.5 + 30초보다 `watchedSec` 증가분이 크면 `flags`에 `'fast_progress'` 추가(저장은 함 — 시계 오차로 정상 기록을 잃지 않기 위해).
  4. `ratio ≥ 0.9`이고 `source !== 'teacher'`이면 `status:'auto_completed', source:'player', completedAt`. **`source==='teacher'`면 status/source/setBy는 건드리지 않고 progress만 갱신.**
  5. `self_confirmed`(옛 자기확인)는 새로 만들지 않음. 기존 값은 auto_completed로 올라가면 대체, 아니면 유지.
- `teacherSetWatchStatus`는 기존 `progress`를 그대로 보존하도록 수정(지금은 레코드를 통째로 새로 만들어 지워짐).

### API (`api/videos/[action].js` → `api/_lib/watch-actions.js`로 위임)
- `watch-progress` (POST, owner 세션, isSameOrigin): 영상이 `listVisibleVideosForOwner`에 있어야 함(없으면 404, play-url과 같은 기준). `checkRateLimit('watch-progress', owner, 60, 60)`. 응답 `{record}`.
- `watch-mine` 응답에 `progress` 포함(기존 호출부 호환: 필드만 추가).
- `watch-admin-list` 응답에 `progress` 포함.
- `watch-admin-week` (GET, 관리자, `schoolId&month&week`): 해당 학교에 보이는 그 월·주차 영상들 × 학교 활성 학생 → `{ videos:[{id,title}], students:{ [studentId]: { completed: n, total: m, best: {videoId, ratio, status, flags} } } }`. 읽기 수 = 학생×영상(주차 단위라 수십 건).
- 라우터 정리: `watch-mine/watch-confirm/watch-progress/watch-admin-list/watch-admin-set/watch-admin-week` 처리 함수를 `api/_lib/watch-actions.js`로 옮기고 `[action].js`는 인증 게이트 + 위임만. 기존 `tests/watch.test.mjs`·`tests/playback.test.mjs`는 그대로 통과해야 함. `watch-confirm`은 4단계에서 화면에서 제거되지만 API는 이번엔 남긴다(기존 자기확인 데이터 호환).

## 4단계 — 재생기 자동 기록 (`lecture.html`)

- 재생 중 `timeupdate`마다 이전 위치와 현재 위치 차이가 `1.5 × 배속`초 이하이면 그 구간을 로컬 segments에 추가(건너뛰기·되감기는 구간이 끊겨 자동 제외). 로컬에서도 병합.
- 전송: 재생 중 15초마다, `pause`·`ended`, 화면 이탈(`visibilitychange` hidden, `pagehide`)에는 `navigator.sendBeacon`(JSON Blob) — 쿠키 동봉, 실패해도 조용히. 새 구간이 없으면 보내지 않음.
- 이어보기: `watch-mine`의 `lastPositionSec`이 있고 끝에서 10초 이상 남았으면 그 위치에서 시작(안내 없이).
- "다 봤어요" 버튼과 `watchStatusHtml`의 self_confirmed 분기 제거. 대신 재생기 아래에 "재생 기준 92% 시청" / "✓ 재생 완료(90% 이상)" / 선생님 정정 시 "선생님 확인 완료" 표시.

## 5단계 — 화면: 내 강의실 · 성적표 시청률 · 영상별 현황

**내 강의실 (`lecture.html` list 화면):**
- 상단 요약 카드: "이번 주" = 목록 중 가장 최근 월·주차 영상들. 각 영상 제목 + 시청률 막대 + 완료 표시. 이번 주 영상이 없으면 "이번 주 영상이 아직 없어요 — 지난 영상은 아래에서".
- 주차별 목록 카드에 시청률 뱃지(`92%`, `완료`, `미시청`)와 기간 표시. 목록 로드 시 `watch-mine?videoIds=전체`를 한 번 호출.
- 회원(강좌 구매)도 같은 뱃지 표시.

**성적표 (`index.html` 학생 화면, 학생 세션):**
- 선택된 월·주차의 성적표 아래에 "이번 주 인강" 칸: `/api/videos/mine` + `/api/videos/watch-mine`로 그 월·주차 영상들의 시청률. 영상이 없으면 칸 자체를 숨김. 클릭하면 `/lecture.html`로.
- 학부모가 아이 계정으로 로그인해서 보는 화면이 이 화면이다 — 문구는 "재생 완료"로.

**영상별 학생 현황 (`index.html` 영상 관리):**
- 각 영상 행에 "시청 현황" 버튼 → 펼치면 허용 학교(현재 선택 학교) 학생별: 이름 · 시청률 · 상태(재생 완료 / 선생님 확인 / 제외 / 미시청) · 마지막 시청일 · `fast_progress`면 "확인 필요" 뱃지. 행마다 "확인"/"제외" 버튼(`watch-admin-set`). 데이터는 `watch-admin-list`(학생 목록은 현재 학교의 활성 학생).

## 6단계 — 인강/현강 체크에 제안 표시 (`index.html` rAttendance)

- 화면 로드 시 `watch-admin-week?schoolId&month&week` 호출. 학생의 그 주차 칸 옆에 작은 뱃지: `인강 93%`(재생 완료면 초록, 미완료면 회색, `fast_progress`면 주황 "확인 필요").
- 뱃지 클릭 = 그 칸을 `인강`으로 설정(기존 선택 UI와 같은 경로, 저장은 기존 "저장하기" 버튼으로). **자동 저장 없음.** 이미 값이 있는 칸은 뱃지만 보여주고 클릭해도 덮어쓰지 않음(확인 창 후에만).
- 영상에 월·주차가 없으면 제안 대상에서 제외.

## 7단계 — 후기 게시판형 (`lecture.html` 후기 화면, `index.html` 후기 관리, `api/courses/[action].js`)

- 데이터: `review` 레코드에 `title`(최대 80자) 추가. 없는 옛 글은 본문 앞 30자를 제목으로 표시.
- `review-list`에 `page`(1부터)·`size`(기본 20) 지원 → `{reviews:[요약: id,title,authorType,authorName,createdAt,commentCount,hasImages], total, page, size}`. 본문·이미지·댓글은 `review-get?id=`로.
- 화면: 목록(번호 없이 제목·글쓴이·날짜·💬댓글수·📷), 페이지 이동, "글쓰기" 버튼(로그인 시). 글 화면: 제목·글쓴이·날짜·본문·이미지·댓글·댓글 입력·"목록으로". 글쓰기 폼에 제목 칸 추가(필수).
- 관리자 후기 관리도 제목 칸 추가, 목록은 제목 위주로.

## 신뢰도 표시 원칙 (모든 화면 공통)
- 자동 기록은 "재생 완료" 또는 "N% 시청"으로만 표기. "수강 완료"·"봤음"이라고 쓰지 않는다.
- 선생님 정정값은 항상 자동값 위에 표시된다.
- `fast_progress`는 학생 화면에는 보이지 않고 선생님 화면에만 "확인 필요"로.

## 테스트
- `tests/watch.test.mjs` 확장(또는 `tests/watch-progress.test.mjs`): 구간 병합·클램프·재계산, 90% 경계, 교사 정정 우선(정정 후 progress 갱신해도 status 유지), `teacherSetWatchStatus`가 progress 보존, fast_progress 플래그, `watch-progress` 401/404(비가시 영상)/400(잘못된 구간), `watch-admin-week` 집계.
- `tests/review.test.mjs` 확장: title 저장·옛 글 제목 대체, 페이지 나누기, `review-get`.
- 라우터 위임 후 기존 테스트 전부 통과.
- 화면은 문법 검사 + 실제 브라우저(데스크톱·휴대폰 폭, 성적표↔인강 왕복 시 로그인 유지, 이어보기, 탭 숨김 시 전송).

## 범위 밖 / 보류
- 학부모 주간 알림톡에 "이번 주 인강 재생 완료 n/m" 한 줄 추가 — 사용자 결정 대기(8단계 후보). 5단계 이후에만 의미 있음.
- 학생별 시청 기간 연장, 유료 강좌 러넥스 재생, 전체 영상×전체 학생 현황판.
- 임시 주소를 복사해 앱 밖에서 재생하는 경우의 추적(불가).
