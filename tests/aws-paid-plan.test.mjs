import assert from "node:assert/strict";
import test from "node:test";
import { assertPaidGpuPlan } from "../lib/aws-gpu-provider.mjs";

// Shape returned by `aws freetier get-account-plan-state` after the 2026-09-26 upgrade:
// a Paid plan has credits but no accountPlanExpirationDate.
const paid = { accountId: "662660921850", accountPlanType: "PAID", accountPlanStatus: "ACTIVE",
  accountPlanRemainingCredits: { amount: 160, unit: "USD" } };

test("an active Paid plan without an expiration date passes the G6 plan check", () => {
  assert.doesNotThrow(() => assertPaidGpuPlan(paid));
});

test("the G6 plan check still refuses Free plans, exhausted credits, and a near expiration", () => {
  assert.throws(() => assertPaidGpuPlan({ ...paid, accountPlanType: "FREE" }), /Paid plan/);
  assert.throws(() => assertPaidGpuPlan({ ...paid, accountPlanRemainingCredits: { amount: 0, unit: "USD" } }), /credits/);
  const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert.throws(() => assertPaidGpuPlan({ ...paid, accountPlanExpirationDate: soon }), /runtime window/);
});
