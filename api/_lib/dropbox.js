// 후기 이미지(카카오톡 캡처 등)를 드롭박스에 저장한다. 영상 전체 카탈로그와 달리 이미지
// 몇 장 수준의 트래픽이라 드롭박스의 대용량 스트리밍 트래픽 스로틀링 정책이 문제되지
// 않는다(2026-09-09 후기 게시판 설계 문서 참고).
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES_PER_REVIEW = 6;

export const REVIEW_IMAGE_LIMITS = { MAX_IMAGE_BYTES, MAX_IMAGES_PER_REVIEW };

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    const err = new Error(`${name} 환경변수가 설정되지 않았습니다`);
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return v;
}

// 접근 토큰은 약 4시간 유효하다. "재생 버튼을 누르면 바로 시작"하도록 매 요청마다 새로 받지 않고
// 같은 서버 인스턴스 안에서 만료 1분 전까지 재사용한다. 만료 정보(expires_in)가 없는 응답은
// 캐시하지 않는다 — 언제 죽을지 모르는 토큰을 무기한 재사용하는 것보다 매번 받는 게 안전.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) return cachedToken;
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
  if (data.expires_in) {
    cachedToken = data.access_token;
    cachedTokenExpiresAt = Date.now() + data.expires_in * 1000;
  }
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
    const err = new Error('이미지는 3MB 이하만 업로드할 수 있습니다');
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

async function rpc(accessToken, endpoint, body) {
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 선생님이 드롭박스 앱 폴더의 videos/에 직접 넣은 파일 목록. 무엇이 "영상 파일"인지는
// video.js(isValidDropboxVideoPath)가 판단한다 — 이 모듈은 드롭박스를 읽기만 한다.
export async function listVideoFolder() {
  const accessToken = await getAccessToken();
  let r = await rpc(accessToken, 'files/list_folder', { path: '/videos', recursive: false });
  if (!r.ok) {
    if (String(r.data?.error_summary || '').startsWith('path/not_found')) return { files: [], folderMissing: true };
    throw new Error('드롭박스 목록을 불러오지 못했습니다');
  }
  const entries = [...(r.data.entries || [])];
  while (r.data.has_more) {
    r = await rpc(accessToken, 'files/list_folder/continue', { cursor: r.data.cursor });
    if (!r.ok) throw new Error('드롭박스 목록을 불러오지 못했습니다');
    entries.push(...(r.data.entries || []));
  }
  const files = entries
    .filter(e => e['.tag'] === 'file')
    .map(e => ({ path: e.path_display, name: e.name, size: e.size || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return { files, folderMissing: false };
}

// 4시간 뒤 자동으로 죽는 직접 재생 주소. 구간 요청을 지원해서 <video>에서 건너뛰기 재생이 된다.
// 주소는 저장하지 않고 재생할 때마다 새로 발급한다(playback.js).
export async function getTemporaryLink(path) {
  const accessToken = await getAccessToken();
  const r = await rpc(accessToken, 'files/get_temporary_link', { path });
  if (!r.ok || !r.data?.link) throw new Error('드롭박스 임시 주소 발급에 실패했습니다');
  return r.data.link;
}
