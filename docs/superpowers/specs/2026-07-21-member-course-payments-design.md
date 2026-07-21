# 일반 회원 가입/로그인 + 강좌 결제 시스템 설계

## 배경

지금까지 oheng에는 두 종류의 로그인만 존재했다: 관리자(학원 선생님, 아이디+비밀번호), 학생(학원이 발급한 학생 ID+비밀번호, 학교별로 관리자가 직접 등록). 두 계정 모두 "학원이 승인/발급"해야만 생기는 폐쇄형 계정이다.

이번 설계는 여기에 **누구나 직접 가입해서 결제하고 인강 영상을 볼 수 있는 일반 회원 시스템**을 추가한다. `oheng.co.kr` 도메인이 이 일반 회원용 영상 서비스의 메인이 되고, 기존 학원용 성적관리 앱은 `oheng.vercel.app`에 그대로 남는다 — 두 서비스는 같은 백엔드/DB를 공유하지만 사용자 그룹과 진입점은 분리된다.

**전제/제약**: 실제 영상 재생(콜러스 DRM 연동)은 아직 계정이 없어 보류 중이다. 이번 설계로 만드는 회원가입·강좌·결제·접근권한 로직은 콜러스 없이도 완결된 기능으로 동작해야 하며, 나중에 재생 부분만 끼워 넣을 수 있어야 한다 (지금 학생용 "인강 시청" 화면과 동일한 원칙).

## 아키텍처 개요

```
oheng.co.kr (신규, 일반 회원용)          oheng.vercel.app (기존, 학원용)
  └ lecture.html                          └ index.html
     - 강좌 둘러보기 (비로그인 가능)              - 관리자 로그인 (학교별 성적관리)
     - 휴대폰 인증 로그인/가입                    - 학생 로그인 (학원 발급 ID)
     - 강좌 결제 (포트원)
     - 구매한 강좌 영상 시청 목록

              ↓ 공유 백엔드 (Vercel Serverless + Upstash Redis) ↓

  video 카탈로그(기존, 확장) · course(신규) · member(신규) · 결제 검증(신규, 포트원)
```

같은 Redis, 같은 Vercel 프로젝트를 쓰지만 `oheng.co.kr`은 Vercel 호스트 기반 rewrite로 `/` 요청을 `lecture.html`로 보낸다. `oheng.vercel.app`은 지금처럼 `index.html`을 그대로 서빙한다 (변경 없음).

## 데이터 모델 (Upstash Redis)

기존 관례(`school:{id}`, `school:index` 등)를 그대로 따른다.

```
member:index                    → 회원 id 배열
member:{id}                     → {
                                     id, phone, name, createdAt,
                                     entitlements: [
                                       { courseId, purchasedAt, expiresAt, paymentId, amount, status }
                                     ],
                                     linkedSchoolId: null,   // 예약 필드 — 이번 스펙에서는 사용 안 함
                                     linkedStudentId: null,  // 나중에 학생 계정과 연동할 때 채움
                                   }
member:phone:{phone}            → member id (로그인 조회용 인덱스, 학생의 student:index 순회 방식과 달리
                                   전화번호가 로그인 키이므로 직접 조회 인덱스가 필요)
otp:{phone}                     → { code, expiresAt, attempts }  (TTL 3분, 검증 실패 5회 시 폐기)
rl:otp-req:{phone 또는 IP}      → 기존 checkRateLimit 재사용 (문자 폭탄 방지)

course:index                    → 강좌 id 배열
course:{id}                     → {
                                     id, title, description, price, durationDays,
                                     videoIds: [기존 video:{id} 의 id들],
                                     published,   // 관리자가 노출 여부 토글
                                     createdAt, updatedAt,
                                   }

order:{orderId}                 → { orderId, memberId, courseId, amount, status:'pending'|'paid', createdAt }
                                   (create-order에서 서버가 직접 생성 — confirm/웹훅이 결제 내용을 대조할 기준)
payment:{paymentId}             → 포트원 결제 검증 결과 로그. `SET ... NX`로 원자적으로 선점해서
                                   confirm과 웹훅이 동시에 들어와도 entitlement가 중복 반영되지 않게 한다.
```

기존 `video:{id}` 스키마는 변경하지 않는다. course는 videoId 배열로 기존 영상을 "가리킬" 뿐이다.

## 인증 흐름 (가입/로그인 통합)

비밀번호가 없는 OTP 전용 로그인이다. 매번 문자로 받은 6자리 코드로 로그인한다.

1. `POST /api/member-auth/otp-request { phone }`
   - Rate limit: 같은 번호 1시간에 5회, 같은 IP 1시간에 10회 (기존 `checkRateLimit` 재사용)
   - 6자리 랜덤 코드 생성 → `otp:{phone}`에 TTL 180초로 저장 (시도 횟수 0으로 초기화)
   - 솔라피 일반 SMS로 발송 (카카오 알림톡 템플릿 아님 — 사전 승인 불필요, 즉시 사용 가능)
2. `POST /api/member-auth/otp-verify { phone, code }`
   - `otp:{phone}` 조회 → 코드 불일치 시 attempts+1 (5회 초과 시 코드 폐기, 재요청 필요), 만료 시 에러
   - 코드 일치 시 `member:phone:{phone}`로 기존 회원 조회
     - 있으면: 세션 발급하고 로그인 완료, `isNew:false`
     - 없으면: 신규 회원 id를 먼저 만들고 **`SET member:phone:{phone} {id} NX`로 전화번호 인덱스를 원자적으로 선점**한 뒤에만 `member:{id}`를 생성한다. NX가 실패하면(동시 요청으로 이미 다른 쪽이 선점) 새로 만들지 않고 그 값으로 기존 회원을 조회해서 로그인 처리 — 동시 인증 시 회원이 중복 생성되는 것을 막는다.
   - 세션은 기존 `createSession`/`setSessionCookie` 재사용, `{role:'member', memberId}` 형태로 저장 (admin/student와 같은 패턴, role만 추가)
3. `isNew:true`인 경우 클라이언트가 이름 입력 화면을 보여주고 `POST /api/member-auth/profile { name }` 호출 (세션 필요, 본인 것만 수정 가능)

`requireMemberSession(req)` 헬퍼를 `api/_lib/auth.js`에 admin/student와 동일한 패턴으로 추가한다.

## 강좌 열람 & 구매

- `GET /api/courses/list` — 로그인 없이도 조회 가능 (제목/설명/가격/수강기간/영상 개수만, `published:true`인 것만). 둘러보기는 누구나.
- `GET /api/courses/mine` — 회원 세션 필요. 내 `entitlements` 중 만료 안 된 것 + 각 course의 videoIds를 풀어서 실제 시청 가능한 영상 목록 반환 (기존 `/api/videos/mine`과 같은 응답 모양을 재사용해서 lecture.html의 렌더링 로직을 그대로 쓸 수 있게 한다).
- `POST /api/payments/create-order { courseId }` — 회원 세션 필요. **서버가 `order:{orderId}` 레코드를 직접 만들어서 저장한다**: `{ orderId, memberId, courseId, amount, status:'pending', createdAt }`. amount는 반드시 서버가 course 가격에서 다시 계산 — 클라이언트가 보낸 금액을 신뢰하지 않는다. 이 orderId를 포트원 결제창에 그대로 넘긴다.
- `POST /api/payments/confirm { paymentId, orderId }` — 결제 위젯 완료 후 클라이언트가 호출. 처리 순서:
  1. `order:{orderId}` 조회 — 없거나 현재 세션의 memberId와 다르면 즉시 거부 (다른 사람 주문에 편승 방지)
  2. **포트원 서버 API로 해당 paymentId의 실제 결제 상태를 재조회** — 상태가 성공이고, 금액이 `order.amount`와 일치하고, 포트원이 돌려준 주문번호가 이 `orderId`와 일치하는지까지 확인 (paymentId만 보고 확인하면 다른 주문의 정상 결제 건을 가져다 재사용하는 공격이 가능하므로 orderId 일치까지 반드시 확인)
  3. 통과 시에만 entitlement 반영

**멱등성은 원자적으로 보장한다.** `confirm` 엔드포인트와 포트원 웹훅이 동시에 들어올 수 있으므로, "조회 후 없으면 기록" 방식이 아니라 `SET payment:{paymentId} {...} NX`로 먼저 선점을 시도하고, 그 SET이 성공했을 때만 `member.entitlements`를 갱신한다. NX가 실패하면(이미 다른 요청이 처리 중/완료) 아무것도 하지 않고 성공 응답만 반환 — 같은 결제가 두 번 반영되는 일이 없다.

포트원 웹훅(결제 상태 변경 알림)도 같은 확인 로직(order 대조 + 포트원 재조회 + NX 선점)을 태우는 별도 엔드포인트로 받아서, 클라이언트가 confirm 호출 전에 이탈해도 서버가 결제 성공을 놓치지 않게 한다 — 웹훅 payload 형식 등 세부 스펙은 실제 포트원 계정으로 연동 테스트하면서 포트원 문서 기준으로 확정한다.

## 접근권한 통합

`api/_lib/video.js`에 함수를 하나 추가한다 (기존 `canStudentAccessVideo`는 그대로 둠):

```js
export function canMemberAccessVideo(video, member) {
  const now = Date.now();
  return (member.entitlements || []).some(e =>
    e.status === 'active' &&
    new Date(e.expiresAt).getTime() > now &&
    courseContainsVideo(e.courseId, video.id) // course.videoIds.includes(video.id)
  );
}
```

한 영상이 학교 접근권한과 강좌 접근권한 둘 다에 걸릴 수도, 한쪽에만 걸릴 수도 있다 — 두 판단은 서로 독립적으로 동작하고 API 레벨에서도 `/api/videos/mine`(학생용, 기존)과 `/api/courses/mine`(회원용, 신규)로 분리되어 있어 서로 다른 사용자 그룹의 데이터가 섞일 일이 없다.

## lecture.html 변경

기존에 만든 학생용 placeholder 로그인/목록 로직과 별개로, 비로그인 상태에서는 **강좌 둘러보기 화면**을 기본으로 보여주도록 확장한다:

- 비로그인: 강좌 목록(제목/가격/수강기간) + "휴대폰 인증하고 구매하기" 진입점
- 로그인(회원): 내가 구매한 강좌의 영상 목록 (기존 주차별 그룹 UI 재사용, 강좌 단위로 그룹핑하도록 소폭 수정)
- 기존 학생 로그인 경로는 이번 스펙 범위에서는 그대로 유지하되, 화면상 "학원 학생이신가요?" 같은 보조 링크로 구분해준다 (완전한 계정 통합은 이번 스펙 범위 밖)

## 에러 처리 요약

| 상황 | 처리 |
|---|---|
| OTP 코드 틀림 | 에러 메시지 + 재입력 (5회 초과 시 코드 폐기, 재요청 안내) |
| OTP 만료 | "인증번호가 만료되었습니다, 다시 받기" |
| 문자 재요청 폭탄 | rate limit로 차단 (429) |
| 결제 금액 위변조 시도 | 서버가 항상 course.price로 재계산 — 클라이언트 금액 무시 |
| 결제 위젯 완료 후 confirm 호출 실패/이탈 | 웹훅이 안전망 역할 |
| 같은 결제 중복 반영 | `payment:{paymentId}` 존재 체크로 멱등 처리 |
| 수강기간 만료 후 접근 시도 | 목록엔 "만료됨"으로 표시, 재생 권한은 거부 |

## 범위 밖 (이번 스펙에서 의도적으로 제외)

- 콜러스 실제 재생 연동 (계정 발급 후 별도 진행)
- 환불/취소 자동화 (전자상거래법상 청약철회 대응은 일단 수동 처리 — 관리자가 직접 entitlement 삭제)
- 학생 계정 ↔ 회원 계정 실제 연동 플로우 (데이터 필드만 예약)
- 쿠폰/할인/프로모션
- 세금계산서/현금영수증 발급 자동화

## 확인 필요 (구현 착수 전 사용자가 준비해야 하는 것)

- 포트원 가맹점 계정 (테스트 채널로 우선 개발 가능, 실 결제 전엔 실 계정 필요)
- 일반인 대상 유료 판매이므로 통신판매업 신고 등 사업자 측 준비 (코드 밖 영역, 별도 진행)
