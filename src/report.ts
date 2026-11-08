import type { ColumnSpec } from "./config";
import type { Issue } from "./github";
import type { Skill } from "./skills";

/** A styled chunk of report text; the board turns blocks into terminal lines and `blocksToMarkdown` into a file. */
export type Block =
	| { kind: "title"; text: string }
	| { kind: "meta"; text: string }
	| { kind: "rule" }
	| { kind: "heading"; text: string }
	| { kind: "kv"; key: string; value: string }
	| { kind: "ticket"; text: string; meta: string }
	| { kind: "text"; text: string };

export type ReportInput = {
	repo: string;
	/** The tickets the report covers (the board's selection). */
	issues: Issue[];
	/** Open tickets in the repo, for the "n of m" header. */
	total: number;
	columns: ColumnSpec[];
	skill?: Skill;
};

export function ago(iso: string): string {
	const s = (Date.now() - Date.parse(iso)) / 1000;
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
}

/** `label 3 · label 2 · …`, biggest first, with a tail count when the list is cut. */
function topCounts(values: string[], limit: number): string {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const shown = sorted.slice(0, limit).map(([v, n]) => (n > 1 ? `${v} ${n}` : v));
	if (sorted.length > limit) shown.push(`+${sorted.length - limit} more`);
	return shown.join(" · ") || "—";
}

/** The prompt a `/{skill}` invocation would hand to an agent for this selection. */
export function reportPrompt(repo: string, issues: Issue[], skill?: Skill): string {
	const numbers = issues.map(i => `#${i.number}`).join(", ") || "(none)";
	const intro = skill
		? `Use the "${skill.name}" skill to produce a status report on ${issues.length} GitHub issues in ${repo}.`
		: `Produce a concise status report on ${issues.length} GitHub issues in ${repo}.`;
	return (
		`${intro} Tickets: ${numbers}. ` +
		"Read each ticket with `gh issue view <n> --comments` before summarizing. " +
		"Group findings by status, flag blockers and stale tickets, and end with a prioritized next-actions list."
	);
}

export function buildReport(d: ReportInput): Block[] {
	const out: Block[] = [
		{ kind: "title", text: d.skill ? `Report · /${d.skill.name}` : "Report · quick summary" },
		{ kind: "meta", text: `${d.repo} · ${d.issues.length} of ${d.total} open tickets · ${new Date().toLocaleString()}` },
		{ kind: "rule" },
	];

	if (d.skill) {
		out.push({ kind: "heading", text: "Skill" });
		out.push({ kind: "kv", key: "name", value: d.skill.name });
		if (d.skill.description) out.push({ kind: "text", text: d.skill.description });
		out.push({ kind: "kv", key: "source", value: d.skill.path });
	}

	out.push({ kind: "heading", text: "Summary" });

	const colLabels = new Set(d.columns.map(c => c.label));
	const perColumn = new Map<string, number>(d.columns.map(c => [c.title, 0]));
	perColumn.set("No status", 0);
	for (const issue of d.issues) {
		const column = d.columns.find(c => issue.labels.includes(c.label));
		const key = column?.title ?? "No status";
		perColumn.set(key, (perColumn.get(key) ?? 0) + 1);
	}
	out.push({
		kind: "kv",
		key: "Columns",
		value: [...perColumn].filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(" · ") || "—",
	});
	out.push({ kind: "kv", key: "Labels", value: topCounts(d.issues.flatMap(i => i.labels.filter(l => !colLabels.has(l))), 10) });
	out.push({ kind: "kv", key: "Assignees", value: topCounts(d.issues.flatMap(i => (i.assignees.length ? i.assignees : ["(unassigned)"])), 10) });
	out.push({ kind: "kv", key: "Authors", value: topCounts(d.issues.map(i => i.author), 6) });

	const times = d.issues.map(i => Date.parse(i.updatedAt)).filter(Number.isFinite);
	out.push({
		kind: "kv",
		key: "Updated",
		value: times.length
			? `oldest ${ago(new Date(Math.min(...times)).toISOString())} ago · newest ${ago(new Date(Math.max(...times)).toISOString())} ago`
			: "—",
	});

	if (d.issues.length) {
		out.push({ kind: "heading", text: `Tickets (${d.issues.length})` });
		for (const issue of d.issues) {
			out.push({
				kind: "ticket",
				text: `#${issue.number} ${issue.title}`,
				meta: [
					...issue.labels.map(l => (colLabels.has(l) ? `[${l}]` : l)),
					...issue.assignees.map(a => `@${a}`),
					`updated ${ago(issue.updatedAt)} ago`,
				].join(" · "),
			});
		}
	}

	out.push({ kind: "heading", text: "Prompt (prototype)" });
	out.push({ kind: "text", text: reportPrompt(d.repo, d.issues, d.skill) });
	out.push({
		kind: "meta",
		text: "Prototype preview: this report is assembled locally from issue metadata — the prompt above is what an agent would receive.",
	});
	return out;
}

/** Renders blocks as a Markdown document (used by the board's `e` export and `y` copy). */
export function blocksToMarkdown(blocks: Block[]): string {
	const lines: string[] = [];
	for (const b of blocks) {
		switch (b.kind) {
			case "title":
				lines.push(`# ${b.text}`);
				break;
			case "meta":
				lines.push(`_${b.text}_`);
				break;
			case "rule":
				break;
			case "heading":
				lines.push("", `## ${b.text}`);
				break;
			case "kv":
				lines.push(`- **${b.key}:** ${b.value}`);
				break;
			case "ticket":
				lines.push(`- **${b.text}**`, `  ${b.meta}`);
				break;
			case "text":
				lines.push("", b.text);
				break;
		}
	}
	return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
