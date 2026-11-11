/** "$0.012", "$1.23", or "<$0.001" for amounts too small to show. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
