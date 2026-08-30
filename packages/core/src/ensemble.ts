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
 * agree when they're on the same file within a few lines of each other. A
 * cluster confirmed by at least `threshold` distinct models is high-confidence;
 * the rest are uncertain. The representative is the highest-severity, most
 * detailed finding in the cluster.
 */
export function mergeEnsemble(
  perModel: readonly (readonly Finding[])[],
  threshold: number,
): EnsembleResult {
  type Cluster = { rep: Finding; models: Set<number> };
  const clusters: Cluster[] = [];

  perModel.forEach((findings, model) => {
    for (const f of findings) {
      const hit = clusters.find(
        (c) => c.rep.path === f.path && Math.abs(c.rep.line - f.line) <= 3,
      );
      if (hit) {
        hit.models.add(model);
        if (isStronger(f, hit.rep)) hit.rep = f;
      } else {
        clusters.push({ rep: f, models: new Set([model]) });
      }
    }
  });

  const confirmed: Finding[] = [];
  const uncertain: Finding[] = [];
  for (const c of clusters) {
    (c.models.size >= threshold ? confirmed : uncertain).push(c.rep);
  }
  return { confirmed, uncertain };
}

function isStronger(a: Finding, b: Finding): boolean {
  if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) {
    return SEV_RANK[a.severity] > SEV_RANK[b.severity];
  }
  return a.body.length > b.body.length;
}
