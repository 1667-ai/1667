/** Refuses commits that give an AI tool authorship or co-authorship.
 *
 * GitHub counts a `Co-Authored-By:` trailer as a contribution and shows the
 * named account on the repository's contributor list. An AI tool is not a
 * contributor, so a commit must not carry that trailer, and must not name a
 * tool as its author or committer.
 *
 * The check runs in CI, where it cannot be bypassed. The `commit-msg` hook
 * runs the same rules earlier, but a hook is optional and `--no-verify`
 * skips it, so CI is the gate that decides.
 */

/** One commit, in the fields this check reads. */
export interface CommitAttribution {
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly message: string;
}

/** One refusal, and the reason a person can act on. */
export interface AttributionRefusal {
  readonly sha: string;
  readonly reason: string;
  readonly evidence: string;
}

/** Email domains that belong to an AI tool rather than to a person. */
const TOOL_EMAIL_PATTERN = /@(anthropic\.com|openai\.com|users\.noreply\.github\.com>?\s*$)/i;

/** Identities that name a tool. Matched against the name and the local part
 *  of the address, never against message prose. */
const TOOL_IDENTITY_PATTERN =
  /\b(claude|anthropic|copilot|codex|chatgpt|openai|cursor|devin|gemini)\b/i;

/** A `Co-Authored-By:` trailer, per the git trailer format. */
const CO_AUTHOR_PATTERN = /^\s*co-authored-by:\s*(.+)$/gim;

function namesATool(identity: string): boolean {
  // Strip the address so a personal address at a normal host cannot match on
  // its domain, then test the display name and the local part together.
  const withoutDomain = identity.replace(/@[^\s>]+/g, " ");
  return TOOL_IDENTITY_PATTERN.test(withoutDomain);
}

function isToolAddress(email: string): boolean {
  if (!TOOL_EMAIL_PATTERN.test(email)) return namesATool(email);
  // A GitHub noreply address belongs to a person unless its local part names
  // a tool, so `743893+10fra@users.noreply.github.com` stays allowed.
  return namesATool(email.split("@")[0] ?? "");
}

/** Report every reason this commit must not be published. */
export function refuseAttribution(commit: CommitAttribution): AttributionRefusal[] {
  const refusals: AttributionRefusal[] = [];
  const identities = [
    { role: "author", name: commit.authorName, email: commit.authorEmail },
    { role: "committer", name: commit.committerName, email: commit.committerEmail }
  ] as const;
  for (const identity of identities) {
    if (namesATool(identity.name) || isToolAddress(identity.email)) {
      refusals.push({
        sha: commit.sha,
        reason: `the ${identity.role} names an AI tool`,
        evidence: `${identity.name} <${identity.email}>`
      });
    }
  }
  for (const match of commit.message.matchAll(CO_AUTHOR_PATTERN)) {
    const trailer = (match[1] ?? "").trim();
    if (namesATool(trailer) || TOOL_EMAIL_PATTERN.test(trailer)) {
      refusals.push({
        sha: commit.sha,
        reason: "a Co-Authored-By trailer names an AI tool",
        evidence: `Co-Authored-By: ${trailer}`
      });
    }
  }
  return refusals;
}

/** Refuse a message alone, before a commit object exists. The `commit-msg`
 *  hook has only this. */
export function refuseMessageAttribution(message: string): AttributionRefusal[] {
  return refuseAttribution({
    sha: "(pending)",
    authorName: "",
    authorEmail: "",
    committerName: "",
    committerEmail: "",
    message
  });
}

/** The text a person reads when the check refuses their work. */
export function refusalReport(refusals: readonly AttributionRefusal[]): string {
  const lines = [
    "",
    "  refused: a commit gives an AI tool authorship or co-authorship",
    ""
  ];
  for (const refusal of refusals) {
    lines.push(`    ${refusal.sha.slice(0, 12)}  ${refusal.reason}`);
    lines.push(`      ${refusal.evidence}`);
  }
  lines.push(
    "",
    "  GitHub counts a Co-Authored-By trailer as a contribution and lists the",
    "  named account as a contributor. A tool is not a contributor.",
    "",
    "  Remove the trailer, then amend or rebase:",
    "",
    "      git commit --amend        # the most recent commit",
    "      git rebase -i <base>      # an older commit",
    "",
    "  To stop Claude Code adding it, put this in ~/.claude/settings.json:",
    "",
    '      "attribution": { "commit": "", "pr": "" }',
    ""
  );
  return lines.join("\n");
}
