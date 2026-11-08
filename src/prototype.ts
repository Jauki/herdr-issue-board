// Prototype hand-off: find the worktree a `/{skill}` run created, publish its artefacts on the
// branch, and post the branch pointer plus screenshots on each ticket it was generated for.
import { basename, join } from "node:path";
import { CommandError, run } from "./proc";

export type Worktree = { path: string; branch: string };

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

export async function listWorktrees(repoCwd: string): Promise<Worktree[]> {
	const out = await run(["git", "worktree", "list", "--porcelain"], repoCwd);
	const trees: Worktree[] = [];
	let path: string | null = null;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line.startsWith("branch ") && path) trees.push({ path, branch: line.slice("branch ".length).replace("refs/heads/", "") });
		else if (!line.trim()) path = null;
	}
	return trees;
}

/** Newest worktree on a `<prefix>` branch, preferring one whose branch ends with the selection range. */
export function pickPrototypeWorktree(trees: Worktree[], prefix: string, range: string): Worktree | undefined {
	const candidates = trees.filter(t => t.branch.startsWith(prefix));
	return candidates.find(t => t.branch.endsWith(range)) ?? candidates[candidates.length - 1];
}

export type Artifact = { rel: string; abs: string; image: boolean };

/** Collects hand-off files (screenshots + the prototype itself) from the worktree's prototype dir. */
export async function findArtifacts(dir: string, globs: string[]): Promise<Artifact[]> {
	const found = new Set<string>();
	for (const pattern of globs) {
		try {
			for (const rel of new Bun.Glob(pattern).scanSync({ cwd: dir, onlyFiles: true })) found.add(rel);
		} catch {}
	}
	return [...found]
		.filter(rel => rel.split("/").every(part => part !== "node_modules" && !part.startsWith(".")))
		.sort()
		.slice(0, 60)
		.map(rel => ({ rel, abs: join(dir, rel), image: IMAGE.test(rel) }));
}

/** Stages, commits (only when dirty) and pushes the given paths on the worktree's branch. */
export async function publishArtifacts(wt: Worktree, rels: string[], message: string): Promise<void> {
	if (!rels.length) return;
	const dirty = (await run(["git", "status", "--porcelain", "--", ...rels], wt.path)).trim();
	if (dirty) {
		await run(["git", "add", "--", ...rels], wt.path);
		await run(["git", "commit", "-m", message, "--", ...rels], wt.path);
	}
	try {
		await run(["git", "push", "-u", "origin", wt.branch], wt.path);
	} catch (err) {
		throw new CommandError(`could not push ${wt.branch}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export const rawUrl = (repo: string, branch: string, rel: string) =>
	`https://raw.githubusercontent.com/${repo}/${branch}/${rel.split("/").map(encodeURIComponent).join("/")}`;

export type CommentInput = {
	branch: string;
	repo: string;
	skill?: string;
	numbers: number[];
	artifacts: Artifact[];
};

export function artifactComment(o: CommentInput): string {
	const shots = o.artifacts.filter(a => a.image).map(a => `![${basename(a.rel)}](${rawUrl(o.repo, o.branch, a.rel)})`);
	const files = o.artifacts.filter(a => !a.image).map(a => `- \`${a.rel}\``);
	const how = o.skill
		? `Generated with the \`/${o.skill}\` skill from the issue board`
		: "Generated with the prototype skill from the issue board";
	return [
		"### Prototype preview",
		"",
		`${how} for ${o.numbers.map(n => `#${n}`).join(", ")}.`,
		"",
		`Prototype branch: \`${o.branch}\` — inspect with \`git fetch origin && git checkout ${o.branch}\`.`,
		"",
		...(shots.length ? ["Screenshots of the prototype:", "", ...shots, ""] : []),
		...(files.length ? ["Prototype files:", "", ...files, ""] : []),
		"---",
		"",
		"Implement this ticket to match the prototype. The prototype is throwaway: fold the validated decision into the real code, then delete the branch.",
	].join("\n");
}

export async function commentOnIssues(cwd: string, numbers: number[], body: string): Promise<void> {
	for (const n of numbers) await run(["gh", "issue", "comment", String(n), "--body", body], cwd);
}
