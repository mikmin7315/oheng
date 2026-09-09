import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) { const existed = store.has(key); store.delete(key); return existed ? 1 : 0; },
  };
}

const fakeRedis = makeFakeRedis();
before(() => {
  mock.module('../api/_lib/redis.js', { namedExports: { getRedis: () => fakeRedis } });
});
const review = await import('../api/_lib/review.js');

test('후기 작성 → 공개 목록에 최신순으로 반영되고 ownerId는 노출되지 않는다', async () => {
  const r1 = await review.createReview({ authorType: 'teacher', authorName: '오은실 대표강사', ownerId: null, text: '첫 후기' });
  const r2 = await review.createReview({ authorType: 'student', authorName: '김학생', ownerId: 'sch1:stu1', text: '두번째 후기', images: ['https://dl.dropboxusercontent.com/a.png'] });

  const list = await review.listReviewsForPublic();
  assert.deepEqual(list.map(r => r.id), [r2.id, r1.id], '최신 작성이 먼저 나와야 함');
  assert.equal(list[0].ownerId, undefined, '공개 목록에는 ownerId가 없어야 함');
  assert.deepEqual(list[0].images, ['https://dl.dropboxusercontent.com/a.png']);
  assert.equal(list[0].comments.length, 0);
});

test('빈 텍스트로 후기를 작성하면 EMPTY_TEXT 에러', async () => {
  await assert.rejects(
    () => review.createReview({ authorType: 'teacher', authorName: '선생님', ownerId: null, text: '   ' }),
    (err) => { assert.equal(err.code, 'EMPTY_TEXT'); return true; }
  );
});

test('댓글 작성 → 해당 후기의 comments에 반영되고, 존재하지 않는 후기면 NOT_FOUND', async () => {
  const r = await review.createReview({ authorType: 'teacher', authorName: '선생님', ownerId: null, text: '댓글 테스트용' });
  const c = await review.addComment(r.id, { authorType: 'student', authorName: '박학생', ownerId: 'sch1:stu2', text: '좋아요' });
  assert.equal(c.authorName, '박학생');

  const list = await review.listReviewsForPublic();
  const found = list.find(x => x.id === r.id);
  assert.equal(found.comments.length, 1);
  assert.equal(found.comments[0].text, '좋아요');
  assert.equal(found.comments[0].ownerId, undefined, '댓글도 ownerId가 공개되면 안 됨');

  await assert.rejects(
    () => review.addComment('no-such-id', { authorType: 'student', authorName: 'x', ownerId: 'a:b', text: 'hi' }),
    (err) => { assert.equal(err.code, 'NOT_FOUND'); return true; }
  );
});

test('관리자 삭제: 후기 삭제 시 댓글도 함께 사라지고, 댓글만 삭제하면 후기는 남는다', async () => {
  const r = await review.createReview({ authorType: 'teacher', authorName: '선생님', ownerId: null, text: '삭제 테스트' });
  const c1 = await review.addComment(r.id, { authorType: 'student', authorName: 'A', ownerId: 'a:1', text: '댓글1' });
  await review.addComment(r.id, { authorType: 'student', authorName: 'B', ownerId: 'a:2', text: '댓글2' });

  await review.deleteComment(r.id, c1.id);
  let list = await review.listReviewsForPublic();
  let found = list.find(x => x.id === r.id);
  assert.equal(found.comments.length, 1);
  assert.equal(found.comments[0].text, '댓글2');

  await review.deleteReview(r.id);
  list = await review.listReviewsForPublic();
  assert.ok(!list.some(x => x.id === r.id));
});

test('이미지는 6장까지만 저장된다', async () => {
  const images = Array.from({ length: 9 }, (_, i) => `https://dl.dropboxusercontent.com/${i}.png`);
  const r = await review.createReview({ authorType: 'teacher', authorName: '선생님', ownerId: null, text: '이미지 개수 제한', images });
  assert.equal(r.images.length, 6);
});
