/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Les budgets : avant l'approbation finale, on additionne ce qui est déjà engagé ce mois-ci.
 * Si le budget est dépassé, il faut une approbation exceptionnelle avec un motif.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { Budget, Dispatch } from "../domain/types.js";
import { COMMITTED } from "../domain/state-machine.js";
import { monthKey } from "../lib/util.js";
import { audit, nowIso, type Ctx } from "./context.js";

export interface BudgetCheck {
  budgetId: string;
  limitCents: number;
  committedCents: number;
  projectedCents: number;
  exceeded: boolean;
  crossedThresholds: number[];
}

/** Coût engagé du mois (statuts engageants) pour un périmètre de budget. */
async function committed(ctx: Ctx, b: Budget, excludeId: string): Promise<number> {
  const rows = await ctx.db.find<Dispatch>("postal_dispatches", {
    legalEntityId: b.legalEntityId,
    status: { in: COMMITTED },
    ...(b.centerId ? { centerId: b.centerId } : {}),
    ...(b.campaignId ? { campaignId: b.campaignId } : {}),
  });
  return rows
    .filter((d) => d.id !== excludeId && d.approvedAt && monthKey(new Date(d.approvedAt)) === b.month)
    .reduce((s, d) => s + (d.quoteTtcCents ?? 0), 0);
}

// EN CLAIR : Calcule pour chaque budget concerné le déjà engagé + ce courrier, et dit si c'est
// dépassé.
/** Vérifie tous les budgets applicables (société, centre, campagne). */
export async function checkBudgets(ctx: Ctx, d: Dispatch, amountCents: number): Promise<BudgetCheck[]> {
  const month = monthKey(ctx.clock.now());
  const budgets = (await ctx.db.find<Budget>("postal_budgets", { legalEntityId: d.legalEntityId, month })).filter(
    (b) => (b.centerId === null || b.centerId === d.centerId) && (b.campaignId === null || b.campaignId === d.campaignId),
  );
  const out: BudgetCheck[] = [];
  for (const b of budgets) {
    const c = await committed(ctx, b, d.id);
    const projected = c + amountCents;
    const before = b.limitCents ? c / b.limitCents : 0;
    const after = b.limitCents ? projected / b.limitCents : 1;
    out.push({
      budgetId: b.id,
      limitCents: b.limitCents,
      committedCents: c,
      projectedCents: projected,
      exceeded: projected > b.limitCents,
      crossedThresholds: (b.alertThresholds ?? [0.5, 0.8, 1]).filter((t) => before < t && after >= t),
    });
  }
  return out;
}

// EN CLAIR : Note dans l'audit le franchissement des seuils (50 %, 80 %, 100 %).
export async function recordBudgetAlerts(ctx: Ctx, d: Dispatch, checks: BudgetCheck[]): Promise<void> {
  for (const c of checks) {
    for (const t of c.crossedThresholds) {
      await audit(ctx, {
        legalEntityId: d.legalEntityId,
        action: "budget.threshold_crossed",
        objectType: "budget",
        objectId: c.budgetId,
        metadata: { threshold: t, projectedCents: c.projectedCents, limitCents: c.limitCents, at: nowIso(ctx) },
      });
    }
  }
}
