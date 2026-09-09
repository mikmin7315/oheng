import { getRedis } from './redis.js';

const REVIEW_PREFIX = 'review:';
const REVIEW_INDEX_KEY = 'review:index';
const COMMENTS_PREFIX = 'review:comments:';

export const REVIEW_TEXT_MAX = 2000;
export const REVIEW_IMAGES_MAX = 6;

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitizeText(raw, maxLen) {
  return String(raw || '').trim().slice(0, maxLen);
}

export async function getReviewIndex() {
  const redis = getRedis();
  const idx = await redis.get(REVIEW_INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

async function getReview(id) {
  const redis = getRedis();
  return await redis.get(REVIEW_PREFIX + id);
}

async function getComments(reviewId) {
  const redis = getRedis();
  const list = await redis.get(COMMENTS_PREFIX + reviewId);
  return Array.isArray(list) ? list : [];
}

// 공개 응답에는 ownerId(학생 개인 식별자)를 절대 포함하지 않는다.
function publicCommentShape(c) {
  return { id: c.id, authorType: c.authorType, authorName: c.authorName, text: c.text, createdAt: c.createdAt };
}
function publicReviewShape(review, comments) {
  return {
    id: review.id, authorType: review.authorType, authorName: review.authorName,
    text: review.text, images: review.images || [], createdAt: review.createdAt,
    comments: comments.map(publicCommentShape),
  };
}

export async function listReviewsForPublic() {
  const index = await getReviewIndex();
  const reviews = await Promise.all(index.map(async id => {
    const review = await getReview(id);
    if (!review) return null;
    const comments = await getComments(id);
    return publicReviewShape(review, comments);
  }));
  // index는 작성 순서대로 push되므로, 뒤집으면 최신순이 된다.
  return reviews.filter(Boolean).reverse();
}

export async function createReview({ authorType, authorName, ownerId, text, images }) {
  const cleanText = sanitizeText(text, REVIEW_TEXT_MAX);
  if (!cleanText) {
    const err = new Error('후기 내용을 입력하세요');
    err.code = 'EMPTY_TEXT';
    throw err;
  }
  const redis = getRedis();
  const review = {
    id: newId('rev'),
    authorType, authorName: String(authorName || '').trim() || (authorType === 'teacher' ? '선생님' : '학생'),
    ownerId: ownerId || null,
    text: cleanText,
    images: (Array.isArray(images) ? images : []).slice(0, REVIEW_IMAGES_MAX),
    createdAt: new Date().toISOString(),
  };
  await redis.set(REVIEW_PREFIX + review.id, review);
  const index = await getReviewIndex();
  index.push(review.id);
  await redis.set(REVIEW_INDEX_KEY, index);
  return review;
}

export async function deleteReview(id) {
  const redis = getRedis();
  await redis.del(REVIEW_PREFIX + id);
  await redis.del(COMMENTS_PREFIX + id);
  const index = await getReviewIndex();
  await redis.set(REVIEW_INDEX_KEY, index.filter(x => x !== id));
}

export async function addComment(reviewId, { authorType, authorName, ownerId, text }) {
  const review = await getReview(reviewId);
  if (!review) {
    const err = new Error('후기를 찾을 수 없습니다');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const cleanText = sanitizeText(text, REVIEW_TEXT_MAX);
  if (!cleanText) {
    const err = new Error('댓글 내용을 입력하세요');
    err.code = 'EMPTY_TEXT';
    throw err;
  }
  const redis = getRedis();
  const comment = {
    id: newId('cmt'),
    authorType, authorName: String(authorName || '').trim() || (authorType === 'teacher' ? '선생님' : '학생'),
    ownerId: ownerId || null,
    text: cleanText,
    createdAt: new Date().toISOString(),
  };
  const comments = await getComments(reviewId);
  comments.push(comment);
  await redis.set(COMMENTS_PREFIX + reviewId, comments);
  return comment;
}

export async function deleteComment(reviewId, commentId) {
  const redis = getRedis();
  const comments = await getComments(reviewId);
  await redis.set(COMMENTS_PREFIX + reviewId, comments.filter(c => c.id !== commentId));
}
