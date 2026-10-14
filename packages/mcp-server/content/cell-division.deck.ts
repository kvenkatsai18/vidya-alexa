import type { Concept } from "../src/domain/types.ts";

/**
 * Pre-built study deck for content/cell-division.md, so the full experience works offline
 * (no LLM). With an LLM connected, uploaded material is turned into a deck like this one
 * automatically.
 */
export type ConceptSeed = Omit<Concept, "id" | "deckId" | "flashcards" | "questions"> & {
  flashcards: Array<{ front: string; back: string }>;
  questions: Array<Omit<Concept["questions"][number], "id">>;
};

export const CELL_DIVISION_DECK: { title: string; subject: string; match: RegExp; concepts: ConceptSeed[] } = {
  title: "Cell division",
  subject: "Biology",
  match: /cell (division|cycle)|mitosis|meiosis/i,
  concepts: [
    {
      title: "The cell cycle",
      summary: "The repeating sequence a dividing cell goes through: interphase (grow and prepare) and the mitotic phase (divide), with checkpoints in between.",
      keyPoints: [
        "Two main parts: interphase and the mitotic phase",
        "Cells spend about 90 percent of their time in interphase",
        "Checkpoints stop the cycle if DNA is damaged or the cell isn't ready",
        "Failed checkpoints can lead to uncontrolled division, as in cancer",
      ],
      confusableWith: [],
      flashcards: [
        { front: "What are the two main parts of the cell cycle?", back: "Interphase and the mitotic phase." },
        { front: "What do cell cycle checkpoints do?", back: "They stop the cycle if DNA is damaged or the cell isn't ready to divide." },
      ],
      questions: [
        { type: "mcq", prompt: "Where does a typical cell spend most of its life?", options: ["Interphase", "Prophase", "Anaphase", "Cytokinesis"], answer: "Interphase", explanation: "About 90 percent of the cycle is interphase, when the cell grows and copies its DNA." },
        { type: "short", prompt: "Why are checkpoints in the cell cycle important?", answer: "They stop the cell from dividing if DNA is damaged or it isn't ready, which prevents uncontrolled division like cancer.", explanation: "Checkpoints are quality control. When they fail, cells can divide uncontrollably." },
        { type: "truefalse", prompt: "True or false: the cell cycle has no way to stop a damaged cell from dividing.", answer: "False", explanation: "Checkpoints exist exactly to stop damaged cells from dividing." },
      ],
      analogies: {
        cricket: "Think of the cell cycle like a cricket season. Most of the time is spent in the nets practising and getting fit, that's interphase. The match itself, the division, is short. And the selectors are the checkpoints: if a player is injured, they don't go out to bat.",
        football: "It's like a football season. Most of the time is training, that's interphase, and match day is the short division phase. The medical check before kick-off is a checkpoint: an injured player doesn't play.",
        cooking: "Think of hosting a dinner. Most of the time is shopping, chopping and prepping, that's interphase. Serving is quick, that's division. And tasting before you serve is the checkpoint: if something's off, it doesn't go out.",
        gaming: "It's like a game loop. You spend most of the time farming and levelling up, that's interphase, then a short boss fight, that's division. Checkpoints are the game refusing to start the boss fight until you have the required gear.",
        music: "It's like preparing for a concert. Most of the time is rehearsal, that's interphase, and the performance is short. The sound check is the checkpoint: if something's broken, the show doesn't start.",
        default: "Think of it like preparing for a big event. Most of the time goes into getting ready, that's interphase, and the event itself is short, that's division. Checkpoints are the last-minute checks that stop things if something's wrong.",
      },
    },
    {
      title: "Interphase and DNA replication",
      summary: "Interphase is the busy preparation stage: G1 (growth), S (DNA is copied into sister chromatids joined at the centromere), and G2 (final growth and preparation).",
      keyPoints: [
        "G1: the cell grows and does its normal job",
        "S phase: all DNA is copied, so each chromosome becomes two sister chromatids",
        "Sister chromatids are joined at the centromere",
        "G2: more growth and making proteins for division",
        "Interphase is not a resting phase",
      ],
      confusableWith: ["resting"],
      flashcards: [
        { front: "What happens in the S phase?", back: "The cell copies its DNA, so each chromosome becomes two sister chromatids." },
        { front: "What joins two sister chromatids?", back: "The centromere." },
      ],
      questions: [
        { type: "mcq", prompt: "In which stage is DNA copied?", options: ["G1", "S phase", "G2", "Metaphase"], answer: "S phase", explanation: "S stands for synthesis: that's when every chromosome is copied." },
        { type: "short", prompt: "What are sister chromatids?", answer: "Two identical copies of a chromosome made during the S phase, joined at the centromere.", explanation: "After DNA replication, each chromosome is a pair of identical sister chromatids held together at the centromere." },
        { type: "truefalse", prompt: "True or false: interphase is a resting phase.", answer: "False", explanation: "The cell is busy growing and copying its DNA during interphase." },
      ],
      analogies: {
        cricket: "Interphase is the pre-match prep. G1 is regular training. S phase is when the kit manager makes an identical second kit for every player, those are the sister chromatids, clipped together at the centromere. G2 is the final warm-up before walking out.",
        football: "G1 is regular training, S phase is printing a duplicate of every player's shirt, the two shirts clipped together are sister chromatids, and G2 is the warm-up before kick-off.",
        cooking: "G1 is shopping and stocking the kitchen. S phase is photocopying every recipe card so there are two identical copies stapled together, those are sister chromatids. G2 is preheating the oven and laying out the tools.",
        gaming: "G1 is levelling up. S phase is making a backup save of everything, two identical copies linked together, that's your sister chromatids at the centromere. G2 is equipping gear before the fight.",
        music: "G1 is daily practice. S phase is photocopying every sheet of music so each musician has two identical copies clipped together. G2 is tuning up before the show.",
        default: "G1 is growing and working normally, S phase is making an exact copy of every chromosome, and the two copies stay joined at the centromere as sister chromatids. G2 is the final preparation before dividing.",
      },
    },
    {
      title: "Phases of mitosis",
      summary: "Mitosis divides copied chromosomes equally into two nuclei in four phases, PMAT: prophase, metaphase, anaphase and telophase.",
      keyPoints: [
        "Prophase: chromosomes condense, spindle forms, nuclear envelope breaks down",
        "Metaphase: chromosomes line up along the middle (metaphase plate)",
        "Anaphase: sister chromatids are pulled to opposite ends",
        "Telophase: new nuclear envelopes form and chromosomes unwind",
        "Remember the order with PMAT",
      ],
      confusableWith: ["meiosis"],
      flashcards: [
        { front: "What is the order of the phases of mitosis?", back: "Prophase, metaphase, anaphase, telophase (PMAT)." },
        { front: "What happens in anaphase?", back: "Sister chromatids are pulled apart to opposite ends of the cell." },
      ],
      questions: [
        { type: "mcq", prompt: "In which phase do chromosomes line up along the middle of the cell?", options: ["Prophase", "Metaphase", "Anaphase", "Telophase"], answer: "Metaphase", explanation: "Metaphase, think M for middle: chromosomes line up on the metaphase plate." },
        { type: "short", prompt: "What happens during anaphase?", answer: "The sister chromatids separate and are pulled to opposite ends of the cell by the spindle.", explanation: "Anaphase, think A for apart: chromatids are pulled apart to the poles." },
        { type: "truefalse", prompt: "True or false: the nuclear envelope breaks down during telophase.", answer: "False", explanation: "It breaks down in prophase and re-forms in telophase." },
      ],
      analogies: {
        cricket: "PMAT is like the end of an innings. Prophase: the players get padded up and the umpires take position. Metaphase: everyone lines up in the middle for the team photo. Anaphase: the two teams walk apart to opposite pavilions. Telophase: each team settles into its own dressing room.",
        football: "Prophase: players get ready and the referee sets up. Metaphase: both teams line up across the halfway line. Anaphase: they split and run to opposite ends. Telophase: each half settles into its own dressing room.",
        cooking: "Prophase: you get the ingredients out and clear the counter. Metaphase: everything lines up down the middle of the counter. Anaphase: you split each pair of ingredients between two bowls. Telophase: you cover each bowl with its own lid.",
        gaming: "Prophase is loading the level. Metaphase is everyone lining up at the centre of the map. Anaphase is the teams splitting to their bases at opposite ends. Telophase is each base putting up its walls.",
        music: "Prophase: musicians take out their instruments. Metaphase: they line up across the middle of the stage. Anaphase: the orchestra splits into two groups that walk to opposite wings. Telophase: each group gets its own room.",
        default: "Prophase: chromosomes pack up and get ready. Metaphase: they line up in the middle. Anaphase: each pair is pulled apart to opposite sides. Telophase: each side gets its own new nucleus.",
      },
    },
    {
      title: "Cytokinesis",
      summary: "Cytokinesis divides the cytoplasm, usually alongside telophase: animal cells pinch in with a cleavage furrow, plant cells build a cell plate.",
      keyPoints: [
        "Division of the cytoplasm, overlapping with telophase",
        "Animal cells: membrane pinches in to form a cleavage furrow",
        "Plant cells: a cell plate forms and becomes a new cell wall",
        "Result: two identical daughter cells",
      ],
      confusableWith: ["telophase"],
      flashcards: [
        { front: "How do animal cells divide their cytoplasm?", back: "The membrane pinches inward to form a cleavage furrow." },
        { front: "How do plant cells divide their cytoplasm?", back: "They build a cell plate that becomes a new cell wall." },
      ],
      questions: [
        { type: "mcq", prompt: "What forms during cytokinesis in a plant cell?", options: ["Cleavage furrow", "Cell plate", "Spindle", "Centromere"], answer: "Cell plate", explanation: "Plant cells have rigid walls, so they build a cell plate instead of pinching in." },
        { type: "short", prompt: "Why can't plant cells form a cleavage furrow?", answer: "Because they have a rigid cell wall, so they build a cell plate down the middle instead.", explanation: "The rigid wall can't pinch inward." },
        { type: "truefalse", prompt: "True or false: cytokinesis divides the cytoplasm, not the nucleus.", answer: "True", explanation: "Mitosis divides the nucleus; cytokinesis splits the rest of the cell." },
      ],
      analogies: {
        cricket: "Mitosis split the teams into two dressing rooms. Cytokinesis is actually building the wall between those rooms. In a tent, an animal cell, you pull the canvas in until it splits. In a brick pavilion, a plant cell, you have to build a new wall down the middle, that's the cell plate.",
        cooking: "It's like splitting dough. A soft dough, an animal cell, you just pinch in the middle until it separates. A tray of baked brownies, a plant cell, is too rigid, so you have to place a divider down the middle.",
        default: "Cytokinesis is splitting the rest of the cell after the nucleus has divided. Animal cells pinch in like squeezing a balloon in the middle. Plant cells have stiff walls, so they build a new wall down the middle instead.",
      },
    },
    {
      title: "Meiosis",
      summary: "Meiosis makes gametes in two divisions, producing four genetically unique haploid cells; homologous chromosomes cross over in prophase I.",
      keyPoints: [
        "Makes gametes (sperm and egg cells)",
        "Two divisions: meiosis I and meiosis II",
        "Produces four haploid cells with half the chromosome number",
        "Crossing over in prophase I swaps DNA between homologous chromosomes",
        "Meiosis I separates homologous pairs; meiosis II separates sister chromatids",
      ],
      confusableWith: ["mitosis"],
      flashcards: [
        { front: "How many cells does meiosis produce, and are they identical?", back: "Four cells, each haploid and genetically different." },
        { front: "What is crossing over?", back: "Homologous chromosomes swapping pieces of DNA during prophase I of meiosis." },
      ],
      questions: [
        { type: "mcq", prompt: "When does crossing over happen?", options: ["Prophase I", "Metaphase II", "Anaphase of mitosis", "S phase"], answer: "Prophase I", explanation: "Homologous chromosomes pair up and swap DNA in prophase I of meiosis." },
        { type: "short", prompt: "Why is every gamete genetically unique?", answer: "Because of crossing over between homologous chromosomes and the random way the pairs line up and separate in meiosis.", explanation: "Crossing over plus random assortment shuffle the genes." },
        { type: "truefalse", prompt: "True or false: meiosis produces two identical diploid cells.", answer: "False", explanation: "That's mitosis. Meiosis produces four genetically different haploid cells." },
      ],
      analogies: {
        cricket: "Meiosis is like picking two brand-new teams for a charity match by mixing players from two clubs. First you pair up players in the same position from each club and they swap caps and bats, that's crossing over. Then you split them up twice, ending with four smaller squads, each one a unique mix.",
        football: "Imagine merging two clubs for a charity tournament. Players in the same position pair up and swap boots, that's crossing over. Then you split twice to make four smaller, unique squads.",
        cooking: "Meiosis is like making four new recipe cards by mixing two family recipes. First matching steps from each recipe swap ingredients, that's crossing over. Then you split them twice, so you end up with four half-size, totally unique recipe cards.",
        gaming: "It's like creating new characters by mixing two parents' stats. Matching stats swap values, that's crossing over, then you split twice, giving four characters each with half the stat slots and a unique build.",
        music: "Think of remixing two songs. Matching sections swap riffs, that's crossing over, then you split the mix twice into four shorter tracks, each one a unique remix.",
        default: "Meiosis shuffles and halves. Matching chromosomes from mum and dad swap pieces, that's crossing over, and then the cell divides twice, giving four cells with half the chromosomes, each one genetically unique.",
      },
    },
    {
      title: "Mitosis versus meiosis",
      summary: "Mitosis: one division, two identical diploid cells for growth and repair (46 to 46 in humans). Meiosis: two divisions, four unique haploid gametes (46 to 23).",
      keyPoints: [
        "Mitosis is for growth and repair; meiosis is for sexual reproduction",
        "Mitosis: one division, two identical diploid cells",
        "Meiosis: two divisions, four genetically different haploid cells",
        "Humans: mitosis keeps 46 chromosomes; meiosis halves to 23",
        "Memory trick: mitosis makes 'my toes', meiosis makes 'me'",
      ],
      confusableWith: ["mitosis", "meiosis"],
      flashcards: [
        { front: "Which division makes identical body cells?", back: "Mitosis." },
        { front: "How many chromosomes are in a human gamete?", back: "23. Meiosis halves the 46 in a body cell." },
      ],
      questions: [
        { type: "mcq", prompt: "Which process produces cells for growth and repair?", options: ["Mitosis", "Meiosis", "Crossing over", "Fertilization"], answer: "Mitosis", explanation: "Mitosis makes identical body cells: think 'my toes'." },
        { type: "short", prompt: "Give two differences between mitosis and meiosis.", answer: "Mitosis has one division and makes two identical diploid cells; meiosis has two divisions and makes four genetically different haploid cells.", explanation: "Compare the number of divisions, number of cells, chromosome number and whether they're identical." },
        { type: "truefalse", prompt: "True or false: in humans, mitosis turns 46 chromosomes into 23.", answer: "False", explanation: "Mitosis keeps 46. Meiosis is the one that halves it to 23." },
      ],
      analogies: {
        cricket: "Mitosis is photocopying your playing XI: one copy, an identical team. Meiosis is building a fresh squad for a new league: you mix two clubs, split twice, and end up with four half-size squads, each one different. Mitosis makes 'my toes', meiosis makes 'me'.",
        cooking: "Mitosis is doubling a recipe exactly: two identical batches. Meiosis is creating four new half-size recipes by mixing two family recipes. Every one is different.",
        gaming: "Mitosis is copy-pasting a save file: two identical copies. Meiosis is breeding new characters: you mix two parents, split twice, and get four unique characters with half the stats each.",
        default: "Mitosis is a photocopier: one division, two identical copies, used for growth and repair. Meiosis is a remix: two divisions, four unique cells with half the chromosomes, used to make sperm and eggs. Mitosis makes 'my toes', meiosis makes 'me'.",
      },
    },
  ],
};
