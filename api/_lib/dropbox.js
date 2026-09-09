// 후기 이미지(카카오톡 캡처 등)를 드롭박스에 저장한다. 영상 전체 카탈로그와 달리 이미지
// 몇 장 수준의 트래픽이라 드롭박스의 대용량 스트리밍 트래픽 스로틀링 정책이 문제되지
// 않는다(2026-09-09 후기 게시판 설계 문서 참고).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_REVIEW = 6;

export const REVIEW_IMAGE_LIMITS = { MAX_IMAGE_BYTES, MAX_IMAGES_PER_REVIEW };

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 환경변수가 설정되지 않았습니다`);
  return v;
}

async function getAccessToken() {
  const appKey = requireEnv('DROPBOX_APP_KEY');
  const appSecret = requireEnv('DROPBOX_APP_SECRET');
  const refreshToken = requireEnv('DROPBOX_REFRESH_TOKEN');
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    }),
  });
  if (!res.ok) throw new Error('드롭박스 인증에 실패했습니다');
  const data = await res.json();
  return data.access_token;
}

// 드롭박스 공유링크는 기본적으로 미리보기 페이지(dl=0)를 가리킨다 — <img src>에 바로 쓸 수
// 있도록 raw=1로 바꿔서 원본 파일을 직접 반환하게 한다.
function toRawUrl(shareUrl) {
  return shareUrl.replace('?dl=0', '?raw=1').replace('&dl=0', '&raw=1');
}

async function getOrCreateSharedLink(accessToken, path) {
  const createRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (createRes.ok) {
    const data = await createRes.json();
    return toRawUrl(data.url);
  }
  // 같은 경로에 이미 공유링크가 있으면 create가 409로 실패한다 — 그 경우 기존 링크를 조회한다.
  const listRes = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, direct_only: true }),
  });
  if (!listRes.ok) throw new Error('드롭박스 공유링크 생성에 실패했습니다');
  const listData = await listRes.json();
  const existing = (listData.links || [])[0];
  if (!existing) throw new Error('드롭박스 공유링크를 찾을 수 없습니다');
  return toRawUrl(existing.url);
}

// dataBase64: 데이터 URL 접두사("data:image/png;base64,") 없이 순수 base64 문자열만 받는다.
export async function uploadReviewImage(dataBase64, filename, mimeType) {
  if (!/^image\//.test(mimeType || '')) {
    const err = new Error('이미지 파일만 업로드할 수 있습니다');
    err.code = 'INVALID_TYPE';
    throw err;
  }
  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) {
    const err = new Error('이미지는 5MB 이하만 업로드할 수 있습니다');
    err.code = 'TOO_LARGE';
    throw err;
  }
  const accessToken = await getAccessToken();
  const safeName = String(filename || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `/review-images/${Date.now()}-${safeName}`;
  const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true, mute: true }),
    },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error('드롭박스 업로드에 실패했습니다');
  const uploaded = await uploadRes.json();
  return await getOrCreateSharedLink(accessToken, uploaded.path_display || path);
}
