// Compares the deal cards shown before and after an event (e.g. closing and reopening the app).
// Only the time labels are ignored, because they change every minute: "just now", "5 min ago", "3h ago", "2d ago"
// (ago() in index.html) and "12 min left", "2h 3m left", "3 days left" (left() in index.html). "ended" is NOT ignored:
// an auction that ended in between is a real change. Prices, titles, badges, scores and order are all compared.
// (Until 9 Nov 2026 only a card's first line was skipped; since the Fliptimize card the time labels are on other lines.)
const TIME = /\b(?:just now|\d+ min ago|\d+h ago|\d+d ago|\d+ min left|\d+h \d+m left|\d+ days left)\b/g;
export const stableText = (c) => c.aria + "|" + c.text.replace(TIME, "⟨time⟩");
// same: true only if every card matches, in the same order; diffs: each differing position with the actual text
export function compareCards(before, after) {
  const a = before.map(stableText), b = after.map(stableText), diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diffs.push({ i, before: before[i] ? before[i].text : "(none)", after: after[i] ? after[i].text : "(none)" });
  return { same: !diffs.length && a.length === b.length, diffs };
}
// for a test report: the lines that really changed (time labels aside) in the first n differing cards, as actual before → after text
export const describeDiffs = (r, n = 1) => r.diffs.slice(0, n).map((d) => { const A = d.before.split("\n"), B = d.after.split("\n"), ch = [];
  for (let j = 0; j < Math.max(A.length, B.length); j++) if ((A[j] ?? "").replace(TIME, "⟨time⟩") !== (B[j] ?? "").replace(TIME, "⟨time⟩") || (A[j] === undefined) !== (B[j] === undefined)) ch.push(`"${A[j] ?? "(none)"}" → "${B[j] ?? "(none)"}"`);
  return `card ${d.i + 1}: ${ch.join(", ")}`; }).join("; ");
