import type { Finding, Severity } from "./types";

const SEV_RANK: Record<Severity, number> = { blocker: 3, warning: 2, nit: 1 };

export type EnsembleResult = {
  /** Findings a majority of models agreed on — high confidence. */
  readonly confirmed: readonly Finding[];
  /** Findings only a minority raised — surfaced as lower-confidence. */
  readonly uncertain: readonly Finding[];
};

/** Majority threshold for N models: 2-of-2, 2-of-3, 3-of-4, … */
export function majority(n: number): number {
  return Math.floor(n / 2) + 1;
}

/**
 * Merge the findings from several models into agreement clusters. Two findings
 * agree when they're on the same file within `proximity` (default 3) lines of
 * each other. A cluster confirmed by at least `threshold` distinct models is
 * high-confidence; the rest are uncertain. The representative is the
 * highest-severity, most detailed finding in the cluster.
 *
 * The union is sorted by (path, line) and clustered in a single left-to-right
 * pass using a fixed anchor (the earliest member), the same approach as
 * {@link dedupeFindings}. This prevents transitive chaining: without it, a
 * model's vote on a nearby-but-distinct issue could inflate an unrelated
 * finding to "confirmed" by pooling votes through an intermediate finding.
 */
export function mergeEnsemble(
  perModel: readonly (readonly Finding[])[],
  threshold: number,
): EnsembleResult {
  // Flatten into one stream tagged with model index, then sort by (path, line).
  type Member = { model: number; finding: Finding };
  const flat: Member[] = [];
  perModel.forEach((findings, model) => {
    for (const finding of findings) flat.push({ model, finding });
  });
  flat.sort((a, b) =>
    a.finding.path < b.finding.path
      ? -1
      : a.finding.path > b.finding.path
        ? 1
        : a.finding.line - b.finding.line,
  );

  // Cluster in a single pass. A finding joins the current cluster only if it
  // agrees with the anchor (earliest member), not the previous finding.
  type Cluster = { anchor: Member; rep: Member; models: Set<number> };
  const clusters: Cluster[] = [];
  for (const member of flat) {
    const last = clusters[clusters.length - 1];
    if (last && findingsAgree(last.anchor.finding, member.finding)) {
      last.models.add(member.model);
      if (isStronger(member.finding, last.rep.finding)) last.rep = member;
    } else {
      clusters.push({
        anchor: member,
        rep: member,
        models: new Set([member.model]),
      });
    }
  }

  const confirmed: Finding[] = [];
  const uncertain: Finding[] = [];
  for (const c of clusters) {
    (c.models.size >= threshold ? confirmed : uncertain).push(c.rep.finding);
  }
  return { confirmed, uncertain };
}

function isStronger(a: Finding, b: Finding): boolean {
  if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) {
    return SEV_RANK[a.severity] > SEV_RANK[b.severity];
  }
  return a.body.length > b.body.length;
}

/**
 * A finding tagged with the reviewer (or single-model run) that produced it.
 * The reviewer name is carried through so the dedupe can hand the surviving
 * representative back to the right reviewer for posting.
 */
export type ReviewerFindings = {
  readonly reviewer: string;
  readonly findings: readonly Finding[];
};

/**
 * Result of cross-reviewer dedupe: one reviewer's surviving inline findings
 * (after near-duplicates raised by other reviewers were suppressed) plus the
 * number that were dropped as duplicates of a finding kept by another reviewer.
 */
export type DedupeResult = {
  readonly reviewer: string;
  readonly inline: readonly Finding[];
  readonly suppressed: number;
};

/**
 * Findings agree when they're on the same file within `proximity` lines of each
 * other (default 3, matching `mergeEnsemble`). Returns true when two findings
 * from different reviewers should be treated as the same claim.
 */
export function findingsAgree(a: Finding, b: Finding, proximity = 3): boolean {
  return a.path === b.path && Math.abs(a.line - b.line) <= proximity;
}

/**
 * Deduplicate the union of several reviewers' inline findings before they're
 * published, so the same reworded claim raised by two reviewers posts once.
 *
 * Two findings are the same claim when they're on the same file within
 * `proximity` lines of each other. The union is sorted by (path, line) and
 * clustered in a single left-to-right pass: a finding joins the current cluster
 * only when it agrees with that cluster's **anchor** — its earliest member —
 * not with the previous finding. This prevents transitive chaining, where a
 * run of findings each within proximity of the next would collapse unrelated
 * issues that happen to sit a few lines apart into one survivor.
 *
 * Each cluster collapses to a single representative — the strongest
 * (highest-severity, then longest body) — attributed to the reviewer that
 * raised it. Other reviewers' copies are suppressed and counted. A reviewer
 * keeps a finding only when it owns the representative of that finding's
 * cluster; every other copy is dropped.
 *
 * Deterministic: sorting by (path, line) makes the result independent of
 * reviewer order. When two findings tie on severity and body length, the one
 * at the earlier line (then earlier in the flattened stream) is kept.
 */
export function dedupeFindings(
  perReviewer: readonly ReviewerFindings[],
  proximity = 3,
): DedupeResult[] {
  // Flatten into one stream tagged with reviewer, then sort by (path, line) so
  // findings on the same file are contiguous and in line order.
  type Member = { reviewer: string; finding: Finding };
  const flat: Member[] = [];
  for (const { reviewer, findings } of perReviewer) {
    for (const finding of findings) flat.push({ reviewer, finding });
  }
  flat.sort((a, b) =>
    a.finding.path < b.finding.path
      ? -1
      : a.finding.path > b.finding.path
        ? 1
        : a.finding.line - b.finding.line,
  );

  // Cluster in a single pass. Each cluster's anchor is its first (earliest-
  // line) member; a finding joins only if it agrees with the anchor. Because
  // the list is sorted by line, a finding that misses the last cluster can't
  // match an earlier one — so we compare against one cluster at a time.
  type Cluster = { anchor: Member; rep: Member; members: Member[] };
  const clusters: Cluster[] = [];
  for (const member of flat) {
    const last = clusters[clusters.length - 1];
    if (last && findingsAgree(last.anchor.finding, member.finding, proximity)) {
      last.members.push(member);
      if (isStronger(member.finding, last.rep.finding)) last.rep = member;
    } else {
      clusters.push({ anchor: member, rep: member, members: [member] });
    }
  }

  // Each cluster has exactly one owner (the reviewer of its representative).
  // The owner posts the representative once; every other member is a duplicate
  // and gets suppressed + counted.
  const byReviewer = new Map<string, { inline: Finding[]; suppressed: number }>(
    perReviewer.map((r) => [r.reviewer, { inline: [], suppressed: 0 }]),
  );
  for (const c of clusters) {
    const ownerSlot = byReviewer.get(c.rep.reviewer);
    if (ownerSlot) ownerSlot.inline.push(c.rep.finding);
    for (const m of c.members) {
      if (m.reviewer === c.rep.reviewer) continue;
      const slot = byReviewer.get(m.reviewer);
      if (!slot) continue; // reviewer with no findings still listed in result
      slot.suppressed++;
    }
  }
  return perReviewer.map((r) => {
    const slot = byReviewer.get(r.reviewer);
    // byReviewer is built from perReviewer keys, so every reviewer maps to its slot.
    if (!slot)
      throw new Error(`dedupeFindings: no slot for reviewer ${r.reviewer}`);
    return {
      reviewer: r.reviewer,
      inline: slot.inline,
      suppressed: slot.suppressed,
    };
  });
}
