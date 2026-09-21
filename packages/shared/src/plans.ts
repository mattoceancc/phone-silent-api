export const FREE_RADIUS_FEET = 125;
export const FREE_RADIUS_METERS = Math.round(125 * 0.3048 * 10) / 10; // 38.1
export const FREE_SPACE_LIMIT = 1;
export const PAID_MONTHLY_USD = 39;
export const PAID_YEARLY_USD = 390;

export const UPGRADE_BLURB =
  "Custom fence, schedules, branding & metrics — $39/mo per space";

export type SpacePlan = "free" | "paid";
export type BillingInterval = "month" | "year";

export function isPaidPlan(plan: string | undefined | null): boolean {
  return plan === "paid";
}
