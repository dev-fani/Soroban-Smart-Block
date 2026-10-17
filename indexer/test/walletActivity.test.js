import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FIELDS_USED,
  isPublicAccountAddress,
  parseInterval,
  summarizeActivity,
  compareAccountActivity,
} from "../src/walletActivity.js";

const ACCOUNT_A = "G" + "A".repeat(55);
const ACCOUNT_B = "G" + "B".repeat(55);

const event = (contract_id, fn, ledger) => ({ contract_id, function: fn, ledger, created_at: "2026-01-01" });

describe("isPublicAccountAddress", () => {
  it("accepts a G-prefixed 56-character base32 key", () => {
    assert.equal(isPublicAccountAddress(ACCOUNT_A), true);
  });

  it("rejects contract (C), malformed, and non-string values", () => {
    assert.equal(isPublicAccountAddress("C" + "A".repeat(55)), false);
    assert.equal(isPublicAccountAddress("GABC"), false);
    assert.equal(isPublicAccountAddress(undefined), false);
    assert.equal(isPublicAccountAddress(["G" + "A".repeat(55)]), false);
  });
});

describe("parseInterval", () => {
  it("returns nulls when no interval is given", () => {
    assert.deepEqual(parseInterval({}), { from: null, to: null });
  });

  it("passes through a valid YYYY-MM-DD range", () => {
    assert.deepEqual(parseInterval({ from: "2026-01-01", to: "2026-01-31" }), {
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("rejects malformed dates", () => {
    assert.throws(() => parseInterval({ from: "01/01/2026" }), RangeError);
    assert.throws(() => parseInterval({ to: "2026-13-45" }), RangeError);
  });

  it("rejects a from date after the to date", () => {
    assert.throws(() => parseInterval({ from: "2026-02-01", to: "2026-01-01" }), /on or before/);
  });
});

describe("summarizeActivity", () => {
  it("returns zeroed figures and null ledgers for an empty account", () => {
    assert.deepEqual(summarizeActivity([]), {
      event_count: 0,
      contract_count: 0,
      contract_ids: [],
      function_counts: {},
      first_ledger: null,
      last_ledger: null,
    });
  });

  it("counts events, distinct contracts, functions, and the ledger span", () => {
    const summary = summarizeActivity([
      event("CB", "transfer", 30),
      event("CA", "transfer", 10),
      event("CA", "mint", 20),
    ]);
    assert.equal(summary.event_count, 3);
    assert.equal(summary.contract_count, 2);
    assert.deepEqual(summary.contract_ids, ["CA", "CB"]);
    assert.deepEqual(summary.function_counts, { transfer: 2, mint: 1 });
    assert.equal(summary.first_ledger, 10);
    assert.equal(summary.last_ledger, 30);
  });

  it("coerces string ledger values from Postgres BIGINT columns", () => {
    const summary = summarizeActivity([event("CA", "transfer", "42")]);
    assert.equal(summary.first_ledger, 42);
    assert.equal(summary.last_ledger, 42);
  });
});

describe("compareAccountActivity", () => {
  it("lists shared contracts and discloses the fields used", () => {
    const result = compareAccountActivity(
      { address: ACCOUNT_A, events: [event("CA", "transfer", 1), event("CX", "swap", 2)] },
      { address: ACCOUNT_B, events: [event("CA", "mint", 5)] },
    );
    assert.equal(result.accounts[0].address, ACCOUNT_A);
    assert.equal(result.accounts[0].event_count, 2);
    assert.equal(result.accounts[1].address, ACCOUNT_B);
    assert.equal(result.accounts[1].event_count, 1);
    assert.deepEqual(result.shared_contract_ids, ["CA"]);
    assert.deepEqual(result.fields_used, FIELDS_USED);
  });

  it("returns no shared contracts when either account is empty", () => {
    const result = compareAccountActivity(
      { address: ACCOUNT_A, events: [] },
      { address: ACCOUNT_B, events: [event("CA", "mint", 5)] },
    );
    assert.deepEqual(result.shared_contract_ids, []);
    assert.equal(result.accounts[0].event_count, 0);
  });
});
