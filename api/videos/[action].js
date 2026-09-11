import { requireAdminSessionOrApiToken, requireStudentSession, requireOwnerSession, isSameOrigin, checkRateLimit } from '../_lib/auth.js';
import { listAllVideos, saveVideo, deleteVideo, isValidDropboxVideoPath } from '../_lib/video.js';
import { makeStudentOwnerId } from '../_lib/entitlements.js';
import { listWatchStatuses, selfConfirmWatch, teacherSetWatchStatus } from '../_lib/watch.js';
import { listVisibleVideosForOwner, resolvePlayUrl } from '../_lib/playback.js';
import { listVideoFolder } from '../_lib/dropbox.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 영상 카탈로그 + 시청기록 + 드롭박스 재생 라우트. Vercel Hobby 플랜의 서버리스 함수 12개 제한 때문에
// 새 파일로 나누지 않고 이 파일에 액션으로 모아둔다.
// 관리자는 전체 목록/등록/수정/삭제, 학생은 본인이 접근 가능한 영상만 조회·재생.
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
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!await checkRateLimit('play-url', `${owner.ownerType}:${owner.ownerId}`, 30, 60)) {
      return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });
    }
    const videoId = String(req.query.videoId || '');
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    res.setHeader('Cache-Control', 'no-store');
    const result = await resolvePlayUrl(owner, videoId);
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    return res.status(200).json({ success: true, url: result.url });
  }

  // 여러 영상의 내 시청 상태를 한 번에 조회 — 회원/학생 둘 다.
  if (action === 'watch-mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const videoIds = String(req.query.videoIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoIds.length) return res.status(200).json({ success: true, statuses: {} });
    const statuses = await listWatchStatuses(owner.ownerType, owner.ownerId, videoIds);
    return res.status(200).json({ success: true, statuses });
  }

  // 학생/회원 본인이 "다 봤어요" — 실제 재생 증거는 아니므로 서버가 status를 고정해서 저장.
  if (action === 'watch-confirm') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const owner = await requireOwnerSession(req);
    if (!owner) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { videoId } = req.body || {};
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    const record = await selfConfirmWatch(owner.ownerType, owner.ownerId, videoId);
    return res.status(200).json({ success: true, record });
  }

  const admin = await requireAdminSessionOrApiToken(req);
  if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized' });

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
      return res.status(502).json({ success: false, message: '드롭박스 목록을 불러오지 못했습니다' });
    }
  }

  // 교사(관리자)가 학생 여러 명의 특정 영상 시청 상태를 한 번에 조회.
  if (action === 'watch-admin-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const videoId = String(req.query.videoId || '');
    const schoolId = String(req.query.schoolId || '');
    const studentIds = String(req.query.studentIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoId || !schoolId || !studentIds.length) {
      return res.status(400).json({ success: false, message: 'Missing videoId/schoolId/studentIds' });
    }
    const entries = await Promise.all(studentIds.map(async sid => {
      const ownerId = makeStudentOwnerId(schoolId, sid);
      const [status] = Object.values(await listWatchStatuses('student', ownerId, [videoId]));
      return [sid, status || null];
    }));
    return res.status(200).json({ success: true, statuses: Object.fromEntries(entries) });
  }

  // 교사가 특정 학생/회원의 특정 영상 시청 상태를 직접 지정/정정.
  if (action === 'watch-admin-set') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { ownerType, memberId, schoolId, studentId, videoId, status } = req.body || {};
    if (!videoId || !status) return res.status(400).json({ success: false, message: 'Missing videoId/status' });
    if (!['teacher_confirmed', 'exempt', 'opened'].includes(status)) {
      return res.status(400).json({ success: false, message: '허용되지 않은 status' });
    }
    let resolvedType, resolvedId;
    if (ownerType === 'member' || memberId) { resolvedType = 'member'; resolvedId = memberId; }
    else if (schoolId && studentId) { resolvedType = 'student'; resolvedId = makeStudentOwnerId(schoolId, studentId); }
    if (!resolvedType || !resolvedId) return res.status(400).json({ success: false, message: 'Missing owner 정보' });
    const record = await teacherSetWatchStatus(resolvedType, resolvedId, videoId, status, admin.actorName || admin.actorId || 'admin');
    return res.status(200).json({ success: true, record });
  }

  return res.status(404).json({ success: false, message: 'Not found' });
}
