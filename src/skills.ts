import { homedir } from "node:os";
import { join } from "node:path";

export type Skill = { name: string; description: string; path: string };

/** Roots scanned for SKILL.md files when the config does not provide `skillDirs`. */
export const DEFAULT_SKILL_DIRS = ["~/.agents/skills", "~/.claude/skills", "~/.opencode/skills"];

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Pulls `name:` and `description:` out of a SKILL.md's leading YAML frontmatter. */
function frontmatter(text: string): { name?: string; description?: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return {};
	const out: { name?: string; description?: string } = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^(name|description):\s*(.*)$/.exec(line);
		if (!kv) continue;
		let value = kv[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		out[kv[1] as "name" | "description"] = value;
	}
	return out;
}

/** Scans `dirs` (plus the repo's own skill folders); first definition of a name wins. */
export async function discoverSkills(opts: { dirs?: string[]; repoCwd?: string } = {}): Promise<Skill[]> {
	const roots = [...(opts.dirs ?? DEFAULT_SKILL_DIRS)];
	if (opts.repoCwd) roots.push(join(opts.repoCwd, ".agents/skills"), join(opts.repoCwd, ".claude/skills"));
	const seen = new Set<string>();
	const skills: Skill[] = [];
	for (const raw of roots) {
		const root = expand(raw);
		let hits: string[] = [];
		for (const pattern of ["*/SKILL.md", "*/*/SKILL.md"]) {
			try {
				hits.push(...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true }));
			} catch {}
		}
		for (const rel of [...new Set(hits)].sort()) {
			const file = join(root, rel);
			let text: string;
			try {
				text = await Bun.file(file).text();
			} catch {
				continue;
			}
			const fm = frontmatter(text);
			const name = (fm.name ?? rel.split("/")[0]).trim();
			if (!name || seen.has(name)) continue;
			seen.add(name);
			skills.push({ name, description: (fm.description ?? "").replace(/\s+/g, " ").trim(), path: file });
		}
	}
	return skills;
}
