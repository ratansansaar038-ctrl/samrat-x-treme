// Shared checks for the two gateways. These have no network or wallet side effects.
export function matchesDepositAmount(amountInr, creditedVC) {
  const amount = Number(amountInr);
  return (
    Number.isFinite(amount) &&
    amount > 0 &&
    Number.isSafeInteger(creditedVC) &&
    creditedVC > 0 &&
    Math.round(amount * 10) === creditedVC
  );
}

// Never try a second payout provider after an unknown or rejected transfer.
export function safePayoutFallback(primary) {
  return (
    primary?.ok === false &&
    primary.needsReview !== true &&
    String(primary.error || "").includes("credentials missing in Appwrite")
  );
}
