// Pure helpers for account-activity comparison (issue #1046) and counterparty
// summaries (issue #1047). No DB or network access happens here: callers pass
// in event rows from db.getWalletEvents and get plain objects back.

// Event columns that feed the summaries. Returned in every comparison response
// so clients can see exactly which fields a figure was derived from.
export const FIELDS_USED = ["contract_id", "function", "ledger", "created_at"];

const PUBLIC_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isPublicAccountAddress(value) {
  return typeof value === "string" && PUBLIC_ACCOUNT_RE.test(value);
}

// Validates the optional YYYY-MM-DD interval shared by the wallet routes.
// Throws a RangeError with a client-facing message on bad input.
export function parseInterval({ from, to } = {}) {
  for (const [name, value] of [["from", from], ["to", to]]) {
    if (value === undefined) continue;
    if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
      throw new RangeError(`${name} must be a YYYY-MM-DD date`);
    }
  }
  if (from && to && from > to) {
    throw new RangeError("from must be on or before to");
  }
  return { from: from ?? null, to: to ?? null };
}

export function summarizeActivity(events) {
  const contractIds = new Set();
  const functionCounts = {};
  let firstLedger = null;
  let lastLedger = null;

  for (const event of events) {
    contractIds.add(event.contract_id);
    functionCounts[event.function] = (functionCounts[event.function] ?? 0) + 1;
    const ledger = Number(event.ledger);
    firstLedger = firstLedger === null ? ledger : Math.min(firstLedger, ledger);
    lastLedger = lastLedger === null ? ledger : Math.max(lastLedger, ledger);
  }

  return {
    event_count: events.length,
    contract_count: contractIds.size,
    contract_ids: [...contractIds].sort(),
    function_counts: functionCounts,
    first_ledger: firstLedger,
    last_ledger: lastLedger,
  };
}

export function compareAccountActivity(left, right) {
  const leftSummary = summarizeActivity(left.events);
  const rightSummary = summarizeActivity(right.events);
  const rightContracts = new Set(rightSummary.contract_ids);
  const sharedContractIds = leftSummary.contract_ids.filter((id) => rightContracts.has(id));

  return {
    accounts: [
      { address: left.address, ...leftSummary },
      { address: right.address, ...rightSummary },
    ],
    shared_contract_ids: sharedContractIds,
    fields_used: FIELDS_USED,
  };
}
