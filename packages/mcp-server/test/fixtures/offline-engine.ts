import type { DeckDraft, Explanation, OfflineEngine, StoryDraft } from "../../src/domain/generate.ts";
import type { Concept, ConceptSeed, ExplainStyle, Learner } from "../../src/domain/types.ts";
import { CELL_DIVISION_DECK } from "./cell-division.deck.ts";

/**
 * TEST FIXTURE ONLY: scripted stand-ins for the model, so tests are fast, free and deterministic.
 * The product never uses this; with no model connected it asks for one instead.
 */
export const offlineEngine: OfflineEngine = {
  deckFromMaterial(_learner, title, text) {
    if (CELL_DIVISION_DECK.match.test(`${title}\n${text.slice(0, 400)}`) && /PMAT|crossing over/i.test(text)) {
      return { title: CELL_DIVISION_DECK.title, subject: CELL_DIVISION_DECK.subject, concepts: CELL_DIVISION_DECK.concepts, truncated: false, source: "fixture" };
    }
    return { ...heuristicDeck(title, text), truncated: false, source: "fixture" };
  },
  deckFromTopic(_learner, topic) {
    if (!CELL_DIVISION_DECK.match.test(topic)) return null;
    return { title: CELL_DIVISION_DECK.title, subject: CELL_DIVISION_DECK.subject, concepts: CELL_DIVISION_DECK.concepts, truncated: false, source: "fixture" };
  },
  explain(learner: Learner, concept: Concept, style: ExplainStyle, misconceptions: string[]): Explanation {
  const key = interestKey(learner, concept.analogies);
  const analogy = concept.analogies?.[key] ?? concept.analogies?.default;
  let explanation: string;
  if (style === "step_by_step" || !analogy) explanation = `${concept.summary} The key points: ${concept.keyPoints.slice(0, 4).map(lcFirst).join("; ")}.`;
  else if (style === "simpler") explanation = `Here's the simple version. ${concept.summary}`;
  else explanation = analogy;
  if (misconceptions.length && concept.confusableWith.length) {
    explanation += ` And remember, last time ${misconceptions[0].charAt(0).toLowerCase()}${misconceptions[0].slice(1)}, so watch out for that.`;
  }
  return { explanation, analogy: analogy && style !== "step_by_step" ? `${key === "default" ? "Everyday" : capitalize(key)} analogy` : undefined, checkQuestion: concept.flashcards[0]?.front ?? `Can you tell me what ${concept.title.toLowerCase()} is?`, source: "fixture" };
  },
  story(child: Learner, lesson: string): StoryDraft {
    return templateStory(child, lesson);
  },
};

/** Offline: one concept per heading (or per paragraph), cloze-style cards from its sentences. */
function heuristicDeck(title: string, text: string): Omit<DeckDraft, "truncated" | "source"> {
  const sections: Array<{ title: string; body: string }> = [];
  const parts = text.split(/\n(?=#{1,3}\s)/);
  for (const p of parts) {
    const m = p.match(/^#{1,3}\s+(.+)\n([\s\S]*)$/);
    if (m && m[2].trim().length > 40) sections.push({ title: m[1].trim(), body: m[2].trim() });
  }
  if (!sections.length) {
    text
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter((b) => b.length > 80)
      .slice(0, 8)
      .forEach((b, i) => sections.push({ title: firstWords(b, 5) || `Part ${i + 1}`, body: b }));
  }
  const concepts: ConceptSeed[] = sections.slice(0, 8).map((s) => {
    const sentences = s.body.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter((x) => x.length > 20);
    const summary = sentences.slice(0, 2).join(" ");
    return {
      title: s.title.replace(/^[\d.]+\s*/, ""),
      summary,
      keyPoints: sentences.slice(0, 5),
      confusableWith: [],
      flashcards: [{ front: `What should you remember about ${s.title.toLowerCase()}?`, back: summary }],
      questions: [
        { type: "short", prompt: `In your own words, what is ${s.title.toLowerCase()}?`, answer: summary, explanation: summary },
        ...(sentences[1] ? [{ type: "truefalse" as const, prompt: `True or false: ${lcFirst(sentences[1])}`, answer: "True", explanation: sentences[1] }] : []),
      ],
    };
  });
  return { title: title || concepts[0]?.title || "My notes", subject: "General", concepts };
}

export function interestKey(learner: Learner, analogies?: Record<string, string>): string {
  if (!analogies) return "default";
  const keys = Object.keys(analogies);
  for (const i of learner.interests) {
    const hit = keys.find((k) => k !== "default" && (i.toLowerCase().includes(k) || k.includes(i.toLowerCase())));
    if (hit) return hit;
  }
  const synonyms: Record<string, string[]> = {
    cricket: ["ipl", "bat", "bowling"],
    football: ["soccer", "fifa", "messi"],
    cooking: ["baking", "food", "chef", "kitchen", "recipes"],
    gaming: ["games", "video games", "minecraft", "fortnite", "roblox", "esports"],
    music: ["singing", "guitar", "piano", "k-pop", "kpop", "songs", "band", "dance"],
  };
  for (const i of learner.interests.map((x) => x.toLowerCase())) {
    for (const [k, words] of Object.entries(synonyms)) if (keys.includes(k) && words.some((w) => i.includes(w))) return k;
  }
  return "default";
}

const WORLDS: Array<{ match: RegExp; hero: string; place: string; friend: string; treasure: string }> = [
  { match: /dino/i, hero: "a little triceratops named Tiko", place: "Fern Valley, where the volcano only ever puffed sleepy clouds", friend: "Rosa the stegosaurus", treasure: "a shiny, star-shaped pebble" },
  { match: /space|rocket|planet|star/i, hero: "a tiny astronaut named Nova", place: "a cosy moon base on the edge of the Milky Way", friend: "Bleep the robot", treasure: "a glowing moon rock" },
  { match: /car|truck|train/i, hero: "a little red train named Ruby", place: "the busy town of Whistle Hill", friend: "Max the tow truck", treasure: "a gleaming golden bell" },
  { match: /unicorn|horse|pony|magic/i, hero: "a small unicorn named Luna", place: "the Meadow of a Thousand Flowers", friend: "Pip the pony", treasure: "a ribbon that shimmered like a rainbow" },
  { match: /cat|dog|puppy|kitten|animal/i, hero: "a curious puppy named Biscuit", place: "a sunny little town by the sea", friend: "Mittens the cat", treasure: "a bright blue ball that squeaked" },
  { match: /football|soccer|cricket|sport/i, hero: "a young bear named Bo who loved to play ball", place: "the Green Hollow playing field", friend: "Ellie the elephant", treasure: "a brand-new, perfectly round ball" },
];

function templateStory(child: Learner, lesson: string): StoryDraft {
  const w = WORLDS.find((x) => child.interests.some((i) => x.match.test(i))) ?? { hero: "a little fox named Fennel", place: "a quiet wood where the trees hummed lullabies", friend: "Owlbert the owl", treasure: "a beautiful red feather" };
  const heroName = w.hero.split(" named ")[1]?.split(" ")[0] ?? "the little fox";
  const friendName = w.friend.split(" ")[0];
  const l = lesson.toLowerCase();
  let middle: string[];
  let question: string;
  if (/steal|taking|take things|theft|rob/.test(l)) {
    middle = [
      `One afternoon, ${heroName} spotted ${w.treasure} sitting all alone. It belonged to ${w.friend}. "Nobody is looking," whispered a little voice inside. "You could just take it." So ${heroName} picked it up and hurried home.`,
      `But that evening, ${heroName}'s tummy felt twisty and heavy. Through the window, ${friendName} was searching everywhere, looking sad. ${heroName} looked at the treasure. It didn't feel shiny anymore. It felt like a secret that was too big to carry.`,
      `So ${heroName} took a deep breath, walked over, and held it out. "I took this. I'm sorry." ${friendName} was quiet for a moment, and then smiled. "Thank you for bringing it back. That was brave." The twisty feeling melted away like snow in the sun.`,
    ];
    question = `Why do you think ${heroName}'s tummy felt twisty, and how did it feel after giving the treasure back?`;
  } else if (/shar/.test(l)) {
    middle = [
      `One day, ${heroName} found ${w.treasure}, the best thing in the whole of ${w.place.split(",")[0]}. "It's all mine," ${heroName} said, holding it tight.`,
      `${w.friend} came by and asked, "Can I see it too?" ${heroName} hid it away. But playing alone wasn't much fun, and soon ${heroName} felt lonely.`,
      `So ${heroName} came back and said, "Let's take turns." They laughed and played until the sky turned pink. Sharing, ${heroName} discovered, made the fun twice as big.`,
    ];
    question = `What happened to the fun when ${heroName} decided to share?`;
  } else if (/brave|scared|fear|afraid|courage/.test(l)) {
    middle = [
      `${heroName} was afraid of the dark path that led home. "What if something is out there?" ${heroName} worried.`,
      `${w.friend} said, "Being brave doesn't mean you're not scared. It means you take one small step anyway." So ${heroName} took one small step, then another.`,
      `The path wasn't so scary after all. There were fireflies lighting the way like tiny lanterns. ${heroName} smiled. One small step at a time, anything is possible.`,
    ];
    question = `What small brave step could you take tomorrow?`;
  } else {
    middle = [
      `One day, ${heroName} had a choice to make. The easy way would have been quicker, but ${heroName} remembered something important: ${lesson.replace(/\.$/, "")}.`,
      `It wasn't easy. ${heroName} felt unsure for a while. But ${w.friend} was watching, and when ${heroName} did the right thing, ${friendName}'s face lit up.`,
      `"I'm proud of you," said ${friendName}. And ${heroName} felt proud too, warm all the way down to the tips of the toes.`,
    ];
    question = `What did ${heroName} learn today?`;
  }
  return {
    title: `${heroName} and the ${/steal|taking|rob/.test(l) ? "Borrowed Treasure" : /shar/.test(l) ? "Best Thing to Share" : /brave|scared|fear|afraid/.test(l) ? "Dark Path Home" : "Right Choice"}`,
    pages: [
      `Once upon a time, in ${w.place}, there lived ${w.hero}. ${heroName}'s best friend was ${w.friend}.`,
      ...middle,
      `That night, ${heroName} curled up, snug and warm, and drifted off to sleep. Goodnight, ${heroName}. And goodnight, ${child.name}.`,
    ],
    question,
  };
}

function lcFirst(s: string) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
function capitalize(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function firstWords(s: string, n: number) {
  return s.split(/\s+/).slice(0, n).join(" ").replace(/[,.;:]$/, "");
}
