const assert = require("node:assert/strict");
const { test } = require("node:test");
const { findBuyingIntentSignal } = require("../buying-signals");

test("does not count generic web-development vendor-seeking language as AI buying intent", () => {
  assert.equal(
    findBuyingIntentSignal("Looking for a reliable web development company?"),
    null
  );
});

test("detects explicit evaluation of voice AI for customer support", () => {
  const signal = findBuyingIntentSignal(
    "We are evaluating AI voice agents for customer support."
  );

  assert.ok(signal);
  assert.match(signal[0], /evaluating AI voice agents/i);
});

test("detects procurement language for contact-center automation", () => {
  const signal = findBuyingIntentSignal(
    "Our RFP requests proposals for contact-center automation."
  );

  assert.ok(signal);
  assert.match(signal[0], /RFP requests proposals for contact-center automation/i);
});

test("does not count product descriptions without a buying action", () => {
  assert.equal(
    findBuyingIntentSignal("We provide conversational AI and voice automation services."),
    null
  );
});
