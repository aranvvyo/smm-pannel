// Client-side parsing for custom-comment orders. Mirrors server/lib/commentOrder.js
// exactly, so the form and the server agree on what a valid comment block is.
export const COMMENT_MAX_LINES = 1000;
export const COMMENT_MAX_LINE_LENGTH = 500;

export function commentLines(raw) {
  return String(raw ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

// Returns null when valid, or a short message for the customer.
export function commentProblem(raw, quantity) {
  const lines = commentLines(raw);
  if (lines.length === 0) return 'Enter at least one comment, one per line.';
  if (lines.length > COMMENT_MAX_LINES) return `Enter no more than ${COMMENT_MAX_LINES} comments.`;
  if (lines.some((l) => l.length > COMMENT_MAX_LINE_LENGTH)) return `Each comment must be ${COMMENT_MAX_LINE_LENGTH} characters or fewer.`;
  if (lines.length !== Number(quantity)) {
    return `One comment per line: you have ${lines.length} comment(s) for a quantity of ${quantity || 0}.`;
  }
  return null;
}
