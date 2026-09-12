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
