// 배포 버전 확인용 — Vercel이 빌드 시 자동으로 채워주는 커밋 SHA를 그대로 노출한다.
// 새 배포가 있는지 클라이언트가 주기적으로 이 값을 비교해서 새로고침을 유도하는 데 사용.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ sha: process.env.VERCEL_GIT_COMMIT_SHA || 'dev' });
}
