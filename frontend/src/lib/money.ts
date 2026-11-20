export function formatMoney(
  amount: number | string | null | undefined,
  currencyCode = "USD",
  decimals = 2,
): string {
  const numeric = typeof amount === "number" ? amount : Number(amount ?? 0);
  const safeValue = Number.isFinite(numeric) ? numeric : 0;
  const code = (currencyCode || "USD").trim().toUpperCase();

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(safeValue);
  } catch {
    return `${code} ${safeValue.toFixed(decimals)}`;
  }
}

export function formatNumber(
  amount: number | string | null | undefined,
  decimals = 2,
): string {
  const numeric = typeof amount === "number" ? amount : Number(amount ?? 0);
  const safeValue = Number.isFinite(numeric) ? numeric : 0;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(safeValue);
}
