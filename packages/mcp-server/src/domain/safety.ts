import type { ConcernCategory } from "./types.ts";

/**
 * Child safety. An AI shouldn't be the one a child relies on when something is seriously wrong, so
 * anything that sounds like self-harm, abuse, bullying, danger or deep sadness is (1) answered kindly,
 * (2) never kept secret, and (3) surfaced to a parent right away. This deterministic check works with
 * no model at all; with a model connected, the skill also asks it to flag subtler things (flag_concern).
 */

interface Rule {
  category: ConcernCategory;
  severity: "urgent" | "high" | "watch";
  pattern: RegExp;
  summary: string;
}

const RULES: Rule[] = [
  {
    category: "self_harm",
    severity: "urgent",
    pattern: /\b(kill (myself|me)|want(ed)? to die|wanna die|don'?t want to (live|be alive|be here)|end (it all|my life)|hurt(ing)? myself|cut(ting)? myself|suicid|better off without me|no reason to live)\b/i,
    summary: "Talked about wanting to hurt themselves or not wanting to live",
  },
  {
    category: "abuse",
    severity: "urgent",
    pattern: /\b((he|she|they|someone|somebody|my \w+) (hits|beats|kicks|chokes|slaps|hurts|touched|touches) me|touch(ed|es)? me (in a way|where|there)|(being|getting) (abused|beaten|hit)|abus(e|ed|ing) me|keep (it|this) a secret from (my )?(mom|dad|parents)|told me not to tell)\b/i,
    summary: "Said someone is hurting them, or asked them to keep a secret",
  },
  {
    category: "danger",
    severity: "urgent",
    pattern: /\b((a |some )?stranger (wants|asked|told|is following|follows)|someone online (wants|asked) (to meet|me to)|meet (up )?with someone (i met )?online|run(ning)? away from home|not safe at home|scared to go home|someone has a (gun|knife))\b/i,
    summary: "Mentioned a stranger, meeting someone from online, running away, or feeling unsafe",
  },
  {
    category: "bullying",
    severity: "high",
    pattern: /\b(bull(y|ies|ied|ying)|(they|kids|everyone|people|someone|somebody)( at school)? (keep |keeps |always )?(laugh(s|ing)? at|mak(e|es|ing) fun of|hit(s|ting)?|push(es|ing)?|pick(s|ing)? on|teas(e|es|ing)|hate) me|(no ?one|nobody)( at school| in (my )?class)? (likes me|wants to (play|sit|talk|be friends) with me|plays with me)|(i have|i've got|i got) no friends|picked on|leave me out|left out of everything)\b/i,
    summary: "Said they're being bullied or left out",
  },
  {
    category: "distress",
    severity: "watch",
    pattern: /\b(i'?m (so |really |always |very )?(sad|depressed|lonely|hopeless|miserable)|feel(ing)? (so |really |very )?(sad|depressed|lonely|hopeless|empty|worthless|alone)|hate my life|cry(ing)? (all the time|every (day|night))|nobody (cares|loves me)|i'?m worthless)\b/i,
    summary: "Said they feel very sad, lonely or hopeless",
  },
];

export interface DetectedConcern {
  category: ConcernCategory;
  severity: "urgent" | "high" | "watch";
  summary: string;
}

export function detectConcern(text: string): DetectedConcern | undefined {
  const t = text.replace(/\s+/g, " ");
  // Common figures of speech that aren't concerns.
  if (/\b(dying (to|of laughter)|die (laughing|of embarrassment)|killing it|kill(ed)? the (test|exam|quiz)|i could die)\b/i.test(t)) return undefined;
  const r = RULES.find((x) => x.pattern.test(t));
  return r ? { category: r.category, severity: r.severity, summary: r.summary } : undefined;
}

/**
 * What to say to the child, at their level. Honest about who will be told: a linked parent is alerted;
 * with no parent linked, nobody is, so the child is encouraged to tell a trusted adult themselves.
 */
export function safetyReply(category: ConcernCategory, name: string, guardian: string | undefined, young: boolean): string {
  const text = guardian ? linkedReply(category, name, guardian, young) : unlinkedReply(category, name, young);
  // No name known: "Thank you for telling me..." instead of ", thank you...".
  return name ? text : text.replace(/^(Aw, )?, /, "$1").replace(/, ,/g, ",").replace(/^\w/, (c) => c.toUpperCase()).replace(/ way, \./, " way.");
}

function linkedReply(category: ConcernCategory, name: string, guardian: string, young: boolean): string {
  const who = guardian ? `your ${guardian.toLowerCase()}` : "a grown-up you trust";
  const g = (guardian ?? "").toLowerCase();
  const they = /mom|mum|mother|grandma|aunt/.test(g) ? "she" : /dad|father|grandpa|uncle/.test(g) ? "he" : "they";
  switch (category) {
    case "self_harm":
      return young
        ? `${name}, thank you for telling me. I care about you, and you deserve to feel safe. I'm going to let ${who} know right now so ${they} can be with you. Please go find ${who} or another grown-up near you.`
        : `${name}, I'm really glad you told me, and I'm so sorry you're feeling this way. You deserve real support from people who love you, so I'm letting ${who} know. If you might hurt yourself right now, please tell someone near you, or call or text 988 to talk to someone straight away. You're not alone.`;
    case "abuse":
      return `${name}, thank you for being brave and telling me. It's not your fault, and you shouldn't have to keep this a secret. I'm going to let ${who} know so ${they} can help keep you safe. If you're in danger right now, tell a grown-up near you or call 911.`;
    case "danger":
      return `${name}, thank you for telling me. Your safety matters most, so please don't meet anyone or go anywhere without a grown-up knowing. I'm letting ${who} know so you can talk about it together.`;
    case "bullying":
      return young
        ? `${name}, that sounds really hard, and it's not okay for anyone to treat you that way. You didn't do anything wrong. I'm going to tell ${who}, so ${they} can help.`
        : `${name}, I'm sorry, that sounds really hard, and it's not your fault. This is something a person who cares about you should help with, so I'm letting ${who} know. You don't have to handle it alone. Do you want to talk about it, or take a break from studying?`;
    case "distress":
      return young
        ? `Aw, ${name}, I'm sorry you feel sad. Feelings like that are important to share with someone who loves you, so I'll let ${who} know you might need a big hug.`
        : `I'm sorry you're feeling this way, ${name}. Thanks for telling me. I'll let ${who} know, because a real person who cares about you can help more than I can. Want to take a break, or do something easy together?`;
  }
}

/** No parent is linked, so no one gets an alert: never claim otherwise. */
function unlinkedReply(category: ConcernCategory, name: string, young: boolean): string {
  const adult = young ? "a grown-up you trust, like your mom, your dad, or your teacher" : "an adult you trust, like a parent, a teacher, or your school counselor";
  switch (category) {
    case "self_harm":
      return young
        ? `${name}, thank you for telling me. I care about you, and you deserve to feel safe. Please go find ${adult} right now and tell them what you told me.`
        : `${name}, I'm really glad you told me, and I'm so sorry you're feeling this way. Please tell ${adult} today. If you might hurt yourself right now, call or text 988 to talk to someone straight away. You're not alone.`;
    case "abuse":
      return `${name}, thank you for being brave and telling me. It's not your fault, and you shouldn't have to keep this a secret. Please tell ${adult} as soon as you can. If you're in danger right now, call 911.`;
    case "danger":
      return `${name}, thank you for telling me. Your safety matters most, so please don't meet anyone or go anywhere without a grown-up knowing. Please tell ${adult} about this today.`;
    case "bullying":
      return young
        ? `${name}, that sounds really hard, and it's not okay for anyone to treat you that way. You didn't do anything wrong. Please tell ${adult}, so they can help.`
        : `${name}, I'm sorry, that sounds really hard, and it's not your fault. Please tell ${adult}. They can help in ways I can't, and you don't have to handle it alone. Do you want to talk about it, or take a break from studying?`;
    case "distress":
      return young
        ? `Aw, ${name}, I'm sorry you feel sad. Feelings like that are important to share, so please tell ${adult}. They might have a big hug for you.`
        : `I'm sorry you're feeling this way, ${name}. Thanks for telling me. Talking to ${adult} can really help. Want to take a break, or do something easy together?`;
  }
}
