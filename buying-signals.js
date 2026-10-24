const BUYING_INTENT_PATTERN =
  /\b(?:evaluat(?:ing|e)|explor(?:ing|e)|implement(?:ing|ed)?|deploy(?:ing|ed)?|adopt(?:ing|ed)?|seeking|piloting|looking\s+for|request(?:ing)?\s+(?:a\s+)?(?:for\s+)?proposal|submit(?:ting)?\s+(?:a\s+)?request\s+for\s+proposal|issue(?:d|s)?\s+an?\s+rfp|rfp)\b.{0,60}\b(?:ai[- ](?:powered\s+)?voice|voice[- ](?:ai|automation|agents?|bots?)|conversational ai|automated (?:customer )?(?:support|service|calls?)|customer[- ]service automation|contact[- ]center automation|call[- ]center automation|ai[- ](?:powered\s+)?(?:customer support|customer service|lead qualification)|lead qualification automation)\b|\b(?:ai[- ](?:powered\s+)?voice|voice[- ](?:ai|automation|agents?|bots?)|conversational ai|automated (?:customer )?(?:support|service|calls?)|customer[- ]service automation|contact[- ]center automation|call[- ]center automation|ai[- ](?:powered\s+)?(?:customer support|customer service|lead qualification)|lead qualification automation)\b.{0,60}\b(?:evaluat(?:ing|e)|explor(?:ing|e)|implement(?:ing|ed)?|deploy(?:ing|ed)?|adopt(?:ing|ed)?|seeking|piloting|looking\s+for|request(?:ing)?\s+(?:a\s+)?(?:for\s+)?proposal|submit(?:ting)?\s+(?:a\s+)?request\s+for\s+proposal|issue(?:d|s)?\s+an?\s+rfp|rfp)\b/i;

function findBuyingIntentSignal(text) {
  return typeof text === "string" ? text.match(BUYING_INTENT_PATTERN) : null;
}

module.exports = { findBuyingIntentSignal };
