// ---------------------------------------------------------------------------
// Custom-comment orders. Pure functions, no database or provider access.
//
// Only services whose type is 'Comments' take comments. For those, the comment
// text is one comment per line, and the quantity must equal the number of
// comment lines (each line is one delivered comment).
//
// ASSUMPTION — NOT VERIFIED AGAINST THE LIVE PROVIDER: the one-comment-per-line
// format and the quantity = number of lines rule follow the common SMM panel
// API convention for "custom comments". No provider documentation for this
// panel's supplier exists in this repository, so confirm the rule with the
// provider before relying on it. The limits below are conservative local caps.
// ---------------------------------------------------------------------------
export const COMMENT_SERVICE_TYPE = 'Comments';
export const COMMENT_MAX_LINES = 1000;
export const COMMENT_MAX_LINE_LENGTH = 500;

export function normalizeCommentLines(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Returns { ok: true, text: string|null } where text is null for services that
// take no comments, or { ok: false, code, message } when the order must not go.
export function validateCommentOrder({ serviceType, quantity, comments }) {
  if (serviceType !== COMMENT_SERVICE_TYPE) return { ok: true, text: null };
  const lines = normalizeCommentLines(comments);
  if (lines.length === 0) {
    return { ok: false, code: 'BAD_COMMENTS', message: 'Enter at least one comment, one per line.' };
  }
  if (lines.length > COMMENT_MAX_LINES) {
    return { ok: false, code: 'BAD_COMMENTS', message: `Enter no more than ${COMMENT_MAX_LINES} comments.` };
  }
  if (lines.some((line) => line.length > COMMENT_MAX_LINE_LENGTH)) {
    return { ok: false, code: 'BAD_COMMENTS', message: `Each comment must be ${COMMENT_MAX_LINE_LENGTH} characters or fewer.` };
  }
  if (lines.length !== Number(quantity)) {
    return {
      ok: false, code: 'BAD_COMMENTS',
      message: `This service needs one comment per line. You entered ${lines.length} comment(s) for a quantity of ${quantity}.`,
    };
  }
  return { ok: true, text: lines.join('\n') };
}
