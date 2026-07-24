import { rewrite, next } from '@vercel/functions';

// oheng.co.kr(및 www) 루트는 인강(강좌) 랜딩페이지로, 그 외 호스트(oheng.vercel.app,
// 프리뷰 배포 등)의 루트는 기존 관리자 앱(index.html)으로.
// vercel.json의 rewrites는 루트에 실제 index.html 파일이 존재하면 항상 파일시스템 라우팅이
// 우선이라 절대 발동하지 않는다 — 그래서 이 조건부 분기는 rewrites가 아니라 미들웨어에서 처리한다.
const LECTURE_HOSTS = new Set(['oheng.co.kr', 'www.oheng.co.kr']);

export const config = {
  matcher: '/',
};

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase();
  if (LECTURE_HOSTS.has(host)) {
    return rewrite(new URL('/lecture.html', request.url));
  }
  return next();
}
