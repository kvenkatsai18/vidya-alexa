import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = process.env.BUDDY_SKILLS_DIR ?? path.resolve(here, "../../../skills");

export interface LoadedSkill {
  name: string;
  description: string;
  dir: string;
  /** SKILL.md body (frontmatter stripped) followed by its referenced files. */
  instructions: string;
}

/**
 * Loads Agent Skills (agentskills.io format) at runtime. The simulator's agent uses them as its
 * operating instructions, the same way a skills-aware agent would load them on demand.
 */
export function loadSkill(dir: string): LoadedSkill {
  const raw = readFileSync(path.join(dir, "SKILL.md"), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${dir}/SKILL.md is missing YAML frontmatter`);
  const front = Object.fromEntries(
    m[1]
      .split("\n")
      .map((l) => l.match(/^(\w[\w-]*):\s*(.*)$/))
      .filter((x): x is RegExpMatchArray => !!x)
      .map((x) => [x[1], x[2].replace(/^["']|["']$/g, "")]),
  );
  let body = m[2].trim();
  // Inline referenced files (progressive disclosure is unnecessary for skills this small).
  for (const ref of body.matchAll(/\]\((references\/[^)]+)\)/g)) {
    const file = path.join(dir, ref[1]);
    if (existsSync(file)) body += `\n\n<!-- ${ref[1]} -->\n${readFileSync(file, "utf8").trim()}`;
  }
  return { name: front.name, description: front.description, dir, instructions: body };
}

export function loadSkills(root = SKILLS_DIR): LoadedSkill[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, "SKILL.md")))
    .map((d) => loadSkill(path.join(root, d.name)))
    .sort((a, b) => (a.name === "study-mentor" ? -1 : b.name === "study-mentor" ? 1 : a.name.localeCompare(b.name)));
}
