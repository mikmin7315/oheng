import { isSameOrigin, checkRateLimit } from './auth.js';
import { listWatchStatuses, selfConfirmWatch, teacherSetWatchStatus, recordProgress, WATCH_COMPLETE_RATIO } from './watch.js';
import { listVisibleVideosForOwner } from './playback.js';
import { listAllVideos, canStudentAccessVideo } from './video.js';
import { getSchool } from './school.js';
import { makeStudentOwnerId } from './entitlements.js';

// 시청 기록 HTTP 액션. 라우터(api/videos/[action].js)는 인증만 하고 여기로 넘긴다 — Vercel 함수 파일
// 개수 한도 때문에 라우트 파일을 늘릴 수 없어, 대신 라우터를 얇게 유지한다(Codex 검토 반영).
export const OWNER_WATCH_ACTIONS = ['watch-mine', 'watch-confirm', 'watch-progress'];
export const ADMIN_WATCH_ACTIONS = ['watch-admin-list', 'watch-admin-set', 'watch-admin-week'];

const WEEKS = ['1주', '2주', '3주', '4주', '5주'];

export async function handleOwnerWatchAction(action, req, res, owner) {
  if (action === 'watch-mine') {
    if (req.method !== 'GET') return res.status(405).end();
    const videoIds = String(req.query.videoIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoIds.length) return res.status(200).json({ success: true, statuses: {} });
    const statuses = await listWatchStatuses(owner.ownerType, owner.ownerId, videoIds);
    return res.status(200).json({ success: true, statuses });
  }

  // 옛 "다 봤어요" — 화면에서는 제거됐지만 기존 데이터 호환을 위해 API는 남긴다.
  if (action === 'watch-confirm') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { videoId } = req.body || {};
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    const record = await selfConfirmWatch(owner.ownerType, owner.ownerId, videoId);
    return res.status(200).json({ success: true, record });
  }

  // 재생기가 15초마다·이탈 시 보내는 실제 재생 구간. 재생 주소 발급과 같은 기준으로 "보이는 영상"만 받는다.
  if (action === 'watch-progress') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    if (!await checkRateLimit('watch-progress', `${owner.ownerType}:${owner.ownerId}`, 60, 60)) {
      return res.status(429).json({ success: false, message: '잠시 후 다시 시도해주세요' });
    }
    const { videoId, durationSec, segments, lastPositionSec } = req.body || {};
    if (!videoId) return res.status(400).json({ success: false, message: 'Missing videoId' });
    const visible = await listVisibleVideosForOwner(owner);
    if (!visible.some(v => v.id === videoId)) return res.status(404).json({ success: false, message: '볼 수 없는 영상입니다' });
    try {
      const record = await recordProgress(owner.ownerType, owner.ownerId, videoId, { durationSec, segments, lastPositionSec });
      return res.status(200).json({ success: true, record });
    } catch (e) {
      if (e.code === 'BAD_INPUT') return res.status(400).json({ success: false, message: e.message });
      throw e;
    }
  }
  return res.status(404).json({ success: false, message: 'Not found' });
}

function summarizeStudent(records) {
  let completed = 0, best = null;
  for (const r of records) {
    if (!r) continue;
    const done = r.status === 'auto_completed' || r.status === 'teacher_confirmed';
    if (done) completed++;
    const ratio = r.progress?.ratio || 0;
    const score = (done ? 1 : 0) * 10 + ratio;
    if (!best || score > best.score) best = { score, videoId: r.videoId, ratio, status: r.status, flags: r.progress?.flags || [] };
  }
  if (best) delete best.score;
  return { completed, best };
}

export async function handleAdminWatchAction(action, req, res, admin) {
  if (action === 'watch-admin-list') {
    if (req.method !== 'GET') return res.status(405).end();
    const videoId = String(req.query.videoId || '');
    const schoolId = String(req.query.schoolId || '');
    const studentIds = String(req.query.studentIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!videoId || !schoolId || !studentIds.length) return res.status(400).json({ success: false, message: 'Missing videoId/schoolId/studentIds' });
    const entries = await Promise.all(studentIds.map(async sid => {
      const [status] = Object.values(await listWatchStatuses('student', makeStudentOwnerId(schoolId, sid), [videoId]));
      return [sid, status || null];
    }));
    return res.status(200).json({ success: true, statuses: Object.fromEntries(entries) });
  }

  if (action === 'watch-admin-set') {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isSameOrigin(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { ownerType, memberId, schoolId, studentId, videoId, status } = req.body || {};
    if (!videoId || !status) return res.status(400).json({ success: false, message: 'Missing videoId/status' });
    if (!['teacher_confirmed', 'exempt', 'opened'].includes(status)) return res.status(400).json({ success: false, message: '허용되지 않은 status' });
    let resolvedType, resolvedId;
    if (ownerType === 'member' || memberId) { resolvedType = 'member'; resolvedId = memberId; }
    else if (schoolId && studentId) { resolvedType = 'student'; resolvedId = makeStudentOwnerId(schoolId, studentId); }
    if (!resolvedType || !resolvedId) return res.status(400).json({ success: false, message: 'Missing owner 정보' });
    const record = await teacherSetWatchStatus(resolvedType, resolvedId, videoId, status, admin.actorName || admin.actorId || 'admin');
    return res.status(200).json({ success: true, record });
  }

  // 인강/현강 체크 화면용 — 한 학교의 한 달(또는 한 주차)에 대해 학생별 완료 수. 읽기 수는 학생 × 그 주차 영상.
  if (action === 'watch-admin-week') {
    if (req.method !== 'GET') return res.status(405).end();
    const schoolId = String(req.query.schoolId || '');
    const month = String(req.query.month || '');
    const week = String(req.query.week || '');
    if (!schoolId || !month) return res.status(400).json({ success: false, message: 'Missing schoolId/month' });
    const school = await getSchool(schoolId);
    if (!school) return res.status(404).json({ success: false, message: '학교를 찾을 수 없습니다' });
    const students = school.students || [];
    const all = (await listAllVideos()).filter(v => v.month === month && (!week || v.week === week));
    const weeks = {};
    for (const wk of (week ? [week] : WEEKS)) {
      const videos = all.filter(v => v.week === wk);
      const perStudent = {};
      for (const s of students) {
        const mine = videos.filter(v => canStudentAccessVideo(v, schoolId, s.id));
        if (!mine.length) { perStudent[s.id] = { completed: 0, total: 0, best: null }; continue; }
        const statuses = await listWatchStatuses('student', makeStudentOwnerId(schoolId, s.id), mine.map(v => v.id));
        const { completed, best } = summarizeStudent(mine.map(v => statuses[v.id]));
        perStudent[s.id] = { completed, total: mine.length, best };
      }
      weeks[wk] = { videos: videos.map(v => ({ id: v.id, title: v.title })), students: perStudent };
    }
    return res.status(200).json({ success: true, weeks, completeRatio: WATCH_COMPLETE_RATIO });
  }
  return res.status(404).json({ success: false, message: 'Not found' });
}
