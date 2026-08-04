/**
 * Marketplace fee split (validation ledger).
 * 1000 bps = 10% Basalt / 90% artist. Stripe Connect can reuse these fields later.
 */
export const PLATFORM_FEE_BPS = 1000;

export function splitSaleCents(amountCents, feeBps = PLATFORM_FEE_BPS) {
  const gross = Math.max(0, Math.round(Number(amountCents) || 0));
  const bps = Math.max(0, Math.min(10000, Math.round(Number(feeBps) || 0)));
  const platform = Math.floor((gross * bps) / 10000);
  const seller = gross - platform;
  return { amountCents: gross, platformFeeCents: platform, sellerNetCents: seller, feeBps: bps };
}

export function sellerNetFromRow(row, feeBps = PLATFORM_FEE_BPS) {
  if (!row) return 0;
  if (row.seller_net_cents != null && row.seller_net_cents !== '') {
    return Math.max(0, Number(row.seller_net_cents) || 0);
  }
  if (!row.seller_id) return 0;
  return splitSaleCents(row.amount_cents, row.fee_bps ?? feeBps).sellerNetCents;
}
