# 후기(리뷰) 게시판 설계

## 배경

`lecture.html`(oheng.co.kr, 일반 대상 인강 마케팅 사이트) 네비게이션의 "실제 후기"는 지금까지 랜딩 페이지 안의 인라인 섹션(learnex.kr에서 가져온 실제 후기 3건, 고정 텍스트)이었다. 이번 설계는 이를 **별도 화면의 후기 게시판**으로 승격한다.

요구사항(사용자 확인 완료):
- 후기는 **이미지(카카오톡 캡처 등) + 텍스트** 둘 다 지원
- 후기는 **선생님(관리자)과 학생 둘 다** 작성 가능
- 후기에는 **댓글**을 달 수 있다
- 조회(후기+댓글)는 **누구나**(비로그인 방문자 포함) 가능 — 마케팅 사이트이므로 후기가 노출돼야 신뢰도에 도움
- 작성(후기/댓글 모두)은 **로그인한 학생/선생님만** 가능 — 승인 절차 없이 즉시 공개되는 자유게시판 방식이므로, 비로그인 작성을 막아 스팸/악성 글 위험을 낮춘다
- 이미지 저장은 **드롭박스**(사용자가 이미 영상 저장소로 결정한 것과 동일한 채널을 재사용)

이 스펙에서 드롭박스 연동이 이 코드베이스에서 처음으로 실제 구현된다 — 지금까지는 "영상은 드롭박스로"라는 결정만 있었고 코드는 없었다. 후기 이미지는 카카오톡 캡처 몇 장 수준이라 트래픽이 적어, 드롭박스의 대용량 스트리밍 트래픽 스로틀링 정책(영상 전체 카탈로그에는 부적합하다고 판단했던 이유)이 문제되지 않는다.

## 아키텍처 개요

```
lecture.html "실제 후기" 화면 (신규, 비로그인 조회 가능)
  - 후기 목록(최신순), 각 후기: 작성자 배지(선생님/학생), 텍스트, 이미지, 댓글 목록
  - 로그인 상태면 "후기 작성" 버튼 + 각 후기에 댓글 입력창 노출
  - 비로그인이면 조회만, 작성 시도 시 로그인 화면으로 유도(기존 강좌 구매 유도 패턴과 동일)

              ↓ 기존 백엔드 재사용 ↓

api/courses/[action].js 에 액션 추가        api/_lib/dropbox.js (신규)
  - review-list (공개, GET)                   - uploadImage(buffer, filename) → 드롭박스 업로드
  - review-create (owner 세션, POST)              + 공유링크(dl=1) 발급, URL 반환
  - review-image-upload (owner 세션, POST)
  - review-delete (관리자, POST)
  - comment-create (owner 세션, POST)
  - comment-delete (관리자, POST)

              ↓ Upstash Redis ↓
review:index, review:{id}, review:comments:{reviewId}
```

새 API 파일을 만들지 않는 이유: Vercel Hobby 플랜 서버리스 함수 12개 한도를 이미 꽉 채우고 있다(`find api -name "*.js" -not -path "*/_lib/*"` = 12개, 이전에 이 한도로 배포가 실패한 적 있음 — `api/watch/[action].js`를 `api/videos/[action].js`에 병합해서 해결). 후기는 `oheng.co.kr` 공개 마케팅 콘텐츠라는 점에서 이미 강좌 공개 목록을 다루는 `api/courses/[action].js`에 액션을 추가하는 것이 가장 자연스럽다.

작성자는 기존 owner 추상화(`requireOwnerSession` → `{ownerType:'student'|'member', ownerId}`)를 재사용한다. 단, 이번 스펙에서는 "선생님(관리자)"과 "학생"만 작성 주체로 요구되었으므로, 관리자는 `requireAdminSessionOrApiToken`으로 별도 처리하고 학생은 `requireOwnerSession`(student만 허용, member는 이번 스펙 범위 밖 — 필요해지면 나중에 추가)으로 처리한다.

## 데이터 모델 (Upstash Redis)

기존 관례(`prefix:index` + `prefix:{id}`)를 그대로 따른다.

```
review:index                → 후기 id 배열 (최신 작성이 배열 뒤에 push, 조회 시 역순 반환)
review:{id}                 → {
                                 id, authorType: 'teacher' | 'student',
                                 authorName,              // 선생님: 표시용 이름(예: "오은실 대표강사"), 학생: 이름 또는 "학생"
                                 ownerId,                  // 학생인 경우 "schoolId:studentId" (삭제/재조회용, 공개 API 응답에는 제외)
                                 text,                      // 최대 2000자
                                 images: [dropboxUrl, ...], // 최대 6장, 각 5MB 이하
                                 createdAt,
                               }
review:comments:{reviewId}  → [
                                 { id, authorType, authorName, ownerId, text, createdAt }
                               ]
                               // 댓글은 후기 하나당 개수가 적을 것으로 예상되어 배열 하나로 관리
                               // (school.students 배열과 동일한 소규모-컬렉션 패턴)
```

`ownerId`는 삭제 권한 확인(작성자 본인 삭제는 이번 스펙 범위 밖, 관리자 삭제만 지원)과 감사용으로 저장하지만 공개 조회 응답(`review-list`)에는 절대 포함하지 않는다 — 학생 개인 식별 정보이므로.

## 드롭박스 이미지 업로드

`api/_lib/dropbox.js` (신규):
- 인증: Dropbox 앱의 refresh token 방식 사용 — `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` 환경변수로 access token을 그때그때 발급(만료 없이 재사용 가능). 세 값 모두 시크릿이므로 사용자가 Vercel 대시보드에 직접 등록한다(기존 PortOne 시크릿과 동일한 방식) — 코드/대화에 값이 노출되지 않게 한다.
- `uploadReviewImage(base64Data, filename)`:
  1. `POST https://content.dropboxapi.com/2/files/upload` — `/review-images/{timestamp}-{filename}` 경로에 업로드
  2. `POST https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings` — 공유링크 생성(이미 있으면 기존 링크 재사용하는 `list_shared_links`로 폴백)
  3. 반환된 `www.dropbox.com/...?dl=0` URL의 `dl=0`을 `raw=1`로 바꿔 `<img src>`에 바로 쓸 수 있는 URL로 변환
- 업로드 전 서버에서 검증: MIME 타입이 `image/*`인지, 디코딩된 바이트 크기가 5MB 이하인지, 후기 하나당 누적 6장 이하인지.

## API 액션 상세 (`api/courses/[action].js`에 추가)

- **`review-list`** (GET, 인증 불필요): 전체 후기 + 각 후기의 댓글을 합쳐서 반환. `ownerId` 필드는 응답에서 제외.
- **`review-create`** (POST, `requireAdminSessionOrApiToken` 또는 `requireOwnerSession`(student)): `{text, images}` 받아 검증(텍스트 비어있지 않음, 길이/이미지 개수 제한) 후 저장.
- **`review-image-upload`** (POST, 관리자 또는 student 세션): `{filename, dataBase64}` 받아 드롭박스 업로드 후 `{url}` 반환 — 프론트는 이 URL들을 모아뒀다가 `review-create` 호출 시 `images` 배열로 함께 보낸다.
- **`comment-create`** (POST, 관리자 또는 student 세션): `{reviewId, text}` 받아 해당 후기의 댓글 배열에 append.
- **`review-delete` / `comment-delete`** (POST, 관리자 전용): 스팸/부적절 게시물 사후 삭제.

모든 POST 액션은 기존 패턴대로 `isSameOrigin(req)` 체크를 거친다.

## 프론트엔드 (`lecture.html`)

- 네비 "실제 후기" 클릭 → `ST.screen = 'reviews'`로 전환(기존 `browse`/`player` 화면 전환 패턴과 동일).
- 후기 목록: 카드 형태, 작성자 배지("👩‍🏫 선생님" / "🙋 학생"), 텍스트, 이미지 그리드, 댓글 목록 + (로그인 시) 댓글 입력.
- 로그인 상태(`ST.mode==='student'`, 관리자 로그인은 이 사이트엔 없으므로 관리자 작성은 `index.html` 관리자 화면에서 처리 — 아래 참고)일 때만 "후기 작성" 버튼 노출. 클릭 시 텍스트 입력 + 이미지 파일 선택(`<input type=file multiple accept=image/*>`) 폼. 이미지는 파일을 base64로 읽어 `review-image-upload`에 순차 전송 후 URL을 모아 `review-create` 호출.
- 비로그인 방문자가 작성/댓글을 시도하면 기존 "로그인 후 이용해주세요" 안내 + 로그인 화면 유도 패턴 재사용.

**선생님(관리자) 작성 경로**: `lecture.html`에는 관리자 로그인이 없으므로, 선생님이 후기를 올리는 UI는 `index.html`(성적관리 관리자 앱) 쪽에 작은 화면/버튼을 하나 추가해 `api/courses/[action].js`의 `review-create`를 관리자 세션(API 토큰)으로 호출하는 방식으로 만든다. (또는 관리자가 원하면 로그인 없이 관리자 토큰으로 curl/도구 호출도 가능하지만, 반복 사용을 고려해 최소한의 버튼 UI를 만든다.)

## 안전장치

- 텍스트 최대 2000자, 이미지 최대 6장, 이미지 파일당 5MB 이하, MIME은 `image/*`만 허용.
- 승인 없는 즉시 공개이므로 관리자 삭제(`review-delete`, `comment-delete`)로 사후 대응.
- 학생 개인 식별 정보(`ownerId`)는 공개 API 응답에서 제외.

## 테스트 계획

`tests/course.test.mjs`에 통합 (기존 강좌 관련 테스트와 같은 파일, 같은 fake-Redis 패턴 재사용):
- 학생 세션으로 `review-create` → `review-list`에 반영되는지
- 관리자 세션으로 `review-create` (선생님 작성) 확인
- 비로그인 요청이 `review-create`/`comment-create`에서 401을 받는지
- `review-list` 응답에 `ownerId`가 포함되지 않는지
- `comment-create` → 해당 후기의 댓글 배열에 반영되는지
- 관리자 `review-delete`/`comment-delete` 동작 확인
- 드롭박스 업로드는 외부 API 호출이므로 `api/_lib/dropbox.js`의 `uploadReviewImage`를 모듈 목으로 대체해 검증(실제 네트워크 호출 없이 URL 생성 로직만 테스트)

## 범위 밖 (이번 스펙에서 다루지 않음)

- 일반 회원(member)의 후기 작성 — 이번엔 선생님/학생만. 필요해지면 `requireOwnerSession`이 이미 member도 지원하므로 나중에 쉽게 확장 가능.
- 작성자 본인의 후기/댓글 수정·삭제 — 관리자 삭제만 지원.
- 신고/자동 필터링 등 콘텐츠 모더레이션 — 관리자 수동 삭제로 대체.
