import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_DOMAIN = process.env.RESEND_EMAIL_DOMAIN || 'oheng.co.kr';
const ADMIN_EMAIL = 'mikmin7315@gmail.com';

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 제목 줄에는 개행 등 제어문자가 섞이면 헤더 인젝션이 될 수 있어 별도로 제거
function sanitizeHeader(s) {
  return String(s).replace(/[\r\n]/g, ' ');
}

// 이메일 발송 실패가 제안 제출 자체를 막으면 안 되므로 항상 조용히 실패 처리
export async function notifyAdminNewSuggestion(schoolName, studentName, cat, text) {
  try {
    await resend.emails.send({
      from: `OHENG <noreply@${FROM_DOMAIN}>`,
      to: [ADMIN_EMAIL],
      subject: sanitizeHeader(`[OHENG] ${schoolName} ${studentName} 학생의 새 제안`),
      html: `<p><b>${escHtml(studentName)}</b> 학생 (${escHtml(schoolName)})이 새 제안을 남겼습니다.</p>
        <p>분류: ${escHtml(cat)}</p>
        <p style="white-space:pre-wrap">${escHtml(text)}</p>`,
    });
  } catch (e) {
    console.error('제안 알림 이메일 발송 실패:', e);
  }
}
