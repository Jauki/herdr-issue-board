import { join } from "node:path";

/** A board column: open issues carrying `label` land here (first matching column wins). */
export type ColumnSpec = { title: string; label: string };

export type Config = {
	/** herdr agent kind started for new tickets (`herdr agent start --kind`). */
	agent: string;
	columns: ColumnSpec[];
	/** Templates; placeholders: {number} {title} {repo} {url} {branch}. */
	prompts: { implement: string; refine: string };
};

const DEFAULTS: Config = {
	agent: "omp",
	columns: [
		{ title: "Needs triage", label: "needs-triage" },
		{ title: "Needs info", label: "needs-info" },
		{ title: "Ready for agent", label: "ready-for-agent" },
		{ title: "Ready for human", label: "ready-for-human" },
	],
	prompts: {
		implement:
			'Implement GitHub issue #{number} in {repo}: "{title}" ({url}). ' +
			"Read the full ticket first with `gh issue view {number} --comments`, then implement it end to end.",
		refine:
			'Help me refine GitHub issue #{number} in {repo}: "{title}" ({url}). ' +
			"Read it with `gh issue view {number} --comments`, ask me what should change, " +
			"then update it with `gh issue edit {number}`. Do not implement it.",
	},
};

/** Loads `$HERDR_PLUGIN_CONFIG_DIR/config.json` over the defaults; `columns` replaces, `prompts` merges. */
export async function loadConfig(): Promise<Config> {
	const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
	if (!dir) return DEFAULTS;
	const file = Bun.file(join(dir, "config.json"));
	if (!(await file.exists())) return DEFAULTS;
	const user = (await file.json()) as Partial<Config>;
	return {
		agent: user.agent ?? DEFAULTS.agent,
		columns: user.columns ?? DEFAULTS.columns,
		prompts: { ...DEFAULTS.prompts, ...user.prompts },
	};
}

export function fill(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}
