// The card's assigned AI is for the next automatic dispatch. A session that is actually
// running in the folder is the better answer to "who is working here now?"
export function currentAgent(issue, claim, sessions = []) {
  const claimed = claim?.codex_live_session?.agent || claim?.issue?.agent;
  if (claimed) return claimed;

  const phaseRank = { working: 2, waiting: 1, idle: 0 };
  const current = sessions.filter((session) => session.name).sort((a, b) =>
    (phaseRank[b.phase] ?? 0) - (phaseRank[a.phase] ?? 0)
    || (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0)
  )[0];
  return current?.name || issue.agent || null;
}
