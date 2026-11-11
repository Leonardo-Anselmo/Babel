// Recognizes provider declines without mistaking ordinary conversation for one.

// A provider can also decline without saying so in the stop reason: it writes a polite
// "I'm sorry, but I can't help with that" and ends the turn normally. That used to be spoken
// out loud, which sounded exactly like the bot refusing in the assistant's voice.
//
// Precision matters more than recall here, because the cost of being wrong is asymmetric:
// a missed decline just leaves the old behaviour, while a false positive throws away a line
// the bot actually wrote and pays for a second call. So every pattern is anchored to the END
// of the reply, spoken in the FIRST person, and requires the verb to point at the request
// ("can't help with THAT", "can't write THAT"). Without that last part, ordinary idioms end
// a line in exactly the same shape: "I can't make it", "I can't help it", "I can't say.",
// "The couch is not comfortable." are all things a person says, not declines.
const END = String.raw`\s*[.!?…]*\s*["'”’)\]]*$`;
// What the refusal is pointed at: a demonstrative, never a bare "it" ("I can't make it").
const OBJECT = String.raw`(?:that|this|those|them|any of (?:that|this|it))(?:\s+(?:request|question|message|task|one|thing|kind of thing|content|information|details?|data|story|script|description|explanation|answer|response|reply|essay|poem|joke|image|picture|photo|drawing|song|lyrics|video|audio|prompt|topic|policy|terms))?`;
const DECLINE = String.raw`(?:\bi\s*(?:can'?t|cannot|won'?t|will not)|\bi(?:\s+am|'m)\s+(?:unable|not able)\s+to)\s+`;
// Verbs that are about producing content or about the request itself. Deliberately NOT "make"
// or "say": "I can't make that" and "I can't say that" are ordinary things a person says (and
// an independent reader classified them as lines, not declines). Missing one of those costs a
// less polished reply; matching one throws away a real answer.
const POINTED = String.raw`(?:help(?:\s+you)?\s+with\s+${OBJECT}|(?:do|write|create|generate|produce|answer|draw|sing|continue|provide|share)\s+${OBJECT}|(?:assist|engage|comply|continue)(?:\s+with\s+${OBJECT})?)`;
const SOFT_REFUSALS = [
  new RegExp(`${DECLINE}${POINTED}${END}`, 'i'),
  // "I have to decline.", "I must decline that request." (first person: "Prices must decline." is news)
  new RegExp(String.raw`\bi\s+(?:have to|must|need to)\s+decline(?:\s+${OBJECT})?${END}`, 'i'),
  // "That's not something I can help with."
  new RegExp(String.raw`\bnot something i (?:can|could) help with${END}`, 'i'),
  // "That would violate my guidelines." (a subject that points at the request, not a bare verb)
  new RegExp(String.raw`\b(?:that|this|it)(?:\s+would|\s+will|'d)?\s+violat(?:e|es|ing)\s+(?:my|the|our)\s+(?:guidelines|polic(?:y|ies)|terms|usage polic(?:y|ies)|content polic(?:y|ies))${END}`, 'i'),
  // "I'm not comfortable with that." (first person: not "the couch is not comfortable")
  new RegExp(String.raw`\bi(?:'m|\s+am) not comfortable(?:\s+(?:with\s+)?${OBJECT}|\s+doing that)?${END}`, 'i'),
  // "I'd rather not."
  new RegExp(String.raw`\bi(?:'d| would) rather not(?:\s+(?:do|answer|help with|write|say|make|draw|sing)\s+(?:that|this|it))?${END}`, 'i'),
  // "As an AI, I have to decline." (needs the decline; "As an AI I'd know" is banter)
  new RegExp(String.raw`\bas an ai\b[^.!?]{0,80}\b(?:can'?t|cannot|won'?t|unable|not able|decline|must|not comfortable|not appropriate)${END}`, 'i'),
];

/**
 * Whether a reply is a provider's polite decline rather than a line: no <say> tags at all,
 * short, and ending in one of the decline shapes. Anything it actually tried to say is not this.
 */
export function looksLikeSoftRefusal(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 600) return false;
  if (/<say\s*>/i.test(t)) return false;
  return SOFT_REFUSALS.some((re) => re.test(t));
}
