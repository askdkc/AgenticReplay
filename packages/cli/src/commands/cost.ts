/** Render an estimated dollar amount without making a small non-zero charge look free. */
export function formatCost(amount: number | null): string {
  if (amount === null) return '—';
  if (amount === 0) return '$0';
  if (amount < 0.0001) return `$${amount.toExponential(2)}`;
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  return `$${amount.toFixed(4)}`;
}
