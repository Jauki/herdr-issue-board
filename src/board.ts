// Kanban board of a repo's open GitHub issues, rendered as a full-screen terminal app inside a herdr pane.
// Columns come from labels (config.ts). Right-click or `m` on a card opens actions that hand the ticket to agents.
import { type ColumnSpec, type Config, fill, loadConfig } from "./config";
import * as gh from "./github";
import * as hd from "./herdr";

const repoCwd = process.env.ISSUE_BOARD_CWD ?? process.cwd();
const originPane = process.env.ISSUE_BOARD_ORIGIN_PANE;
const selfPane = process.env.HERDR_PANE_ID;

// ── text helpers ────────────────────────────────────────────────────────────

const width = (s: string) => Bun.stringWidth(s);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Strips escape sequences and control characters from untrusted text (issue titles/bodies). */
function clean(s: string): string {
	return s
		.replace(/\r\n?/g, "\n")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
		.replace(/\t/g, "  ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

function truncate(s: string, w: number): string {
	if (w <= 0) return "";
	if (width(s) <= w) return s;
	let out = "";
	let used = 0;
	for (const ch of s) {
		const cw = width(ch);
		if (used + cw > w - 1) break;
		out += ch;
		used += cw;
	}
	return `${out}…`;
}

const fit = (s: string, w: number) => {
	const t = truncate(s, w);
	return t + " ".repeat(Math.max(0, w - width(t)));
};

function wrap(text: string, w: number): string[] {
	const lines: string[] = [];
	if (w < 2) return [truncate(text, w)];
	for (const para of text.split("\n")) {
		if (para.trim() === "") {
			lines.push("");
			continue;
		}
		let line = "";
		for (let word of para.split(/ +/)) {
			while (width(word) > w) {
				if (line) lines.push(line);
				line = "";
				const chars = [...word];
				let chunk = "";
				let used = 0;
				let i = 0;
				for (; i < chars.length && used + width(chars[i]) <= w; i++) {
					chunk += chars[i];
					used += width(chars[i]);
				}
				if (i === 0) i = 1;
				lines.push(chunk || chars[0]);
				word = chars.slice(i).join("");
			}
			if (!word) continue;
			if (!line) line = word;
			else if (width(line) + 1 + width(word) <= w) line += ` ${word}`;
			else {
				lines.push(line);
				line = word;
			}
		}
		if (line) lines.push(line);
	}
	return lines;
}

// SGR styles that turn themselves off without a full reset, so a surrounding inverse survives.
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const fg = (code: number, s: string) => `\x1b[${code}m${s}\x1b[39m`;
const INV = "\x1b[7m";
const RESET = "\x1b[0m";
const [RED, GREEN, YELLOW, CYAN, MAGENTA] = [31, 32, 33, 36, 35];

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/, "");

function ago(iso: string): string {
	const s = (Date.now() - Date.parse(iso)) / 1000;
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
}

// ── state ───────────────────────────────────────────────────────────────────

type Column = { spec: ColumnSpec | null; title: string; issues: gh.Issue[]; scroll: number };
type MenuItem = {
	label: string;
	disabled?: boolean;
	run?: () => unknown;
	submenu?: () => MenuItem[] | Promise<MenuItem[]>;
};
type Menu = { title: string; items: MenuItem[]; index: number; x: number; y: number; parent: Menu | null };
type Detail = { issue: gh.Issue; data: gh.IssueDetail | null; error: string | null; scroll: number };
type Rect = { x0: number; y0: number; x1: number; y1: number };

let config: Config;
let repo = "";
let issues: gh.Issue[] = [];
let columns: Column[] = [];
let loaded = false;
let selCol = 0;
let selRow = 0;
let colOffset = 0;
let menu: Menu | null = null;
let detail: Detail | null = null;
let agents: hd.AgentInfo[] = [];
let status: { text: string; color: number | null } = { text: "Loading issues…", color: null };
let busy = false;

// Hit-test tables rebuilt every render (0-based screen cells).
let cardHits: (Rect & { col: number; row: number })[] = [];
let titleHits: (Rect & { col: number })[] = [];
let menuRect: Rect | null = null;
let menuItemRows: { y: number; index: number }[] = [];

const selectedIssue = (): gh.Issue | undefined => columns[selCol]?.issues[selRow];
const columnLabels = () => config.columns.map(c => c.label);

function setStatus(text: string, color: number | null = null) {
	status = { text, color };
	render();
}

function buildColumns() {
	const keep = selectedIssue()?.number;
	const buckets = config.columns.map(() => [] as gh.Issue[]);
	const rest: gh.Issue[] = [];
	for (const issue of issues) {
		const i = config.columns.findIndex(c => issue.labels.includes(c.label));
		(i >= 0 ? buckets[i] : rest).push(issue);
	}
	const scrolls = new Map(columns.map(c => [c.title, c.scroll]));
	columns = [];
	if (rest.length) columns.push({ spec: null, title: "No status", issues: rest, scroll: scrolls.get("No status") ?? 0 });
	config.columns.forEach((spec, i) =>
		columns.push({ spec, title: spec.title, issues: buckets[i], scroll: scrolls.get(spec.title) ?? 0 }),
	);
	if (keep !== undefined) {
		for (let c = 0; c < columns.length; c++) {
			const r = columns[c].issues.findIndex(i => i.number === keep);
			if (r >= 0) {
				selCol = c;
				selRow = r;
				return;
			}
		}
	}
	selCol = clamp(selCol, 0, columns.length - 1);
	selRow = clamp(selRow, 0, Math.max(0, columns[selCol].issues.length - 1));
}

/** Live agents this board started for an issue are named `issue-<n>` or `issue-<n>-<k>`. */
function agentFor(issue: gh.Issue): hd.AgentInfo | undefined {
	const re = new RegExp(`^issue-${issue.number}(-\\d+)?$`);
	return agents.find(a => a.name && re.test(a.name));
}

const statusColor = (s: string) =>
	s === "working" ? YELLOW : s === "blocked" ? RED : s === "idle" || s === "done" ? GREEN : MAGENTA;

// ── layout + render ─────────────────────────────────────────────────────────

const CARD_H = 3;
const GAP = 1;
const MIN_COL_W = 26;
const BODY_TOP = 3;

function layout() {
	const W = process.stdout.columns ?? 80;
	const H = process.stdout.rows ?? 24;
	const n = Math.max(1, columns.length);
	const visible = clamp(Math.floor((W + 1) / (MIN_COL_W + 1)), 1, n);
	if (selCol < colOffset) colOffset = selCol;
	if (selCol >= colOffset + visible) colOffset = selCol - visible + 1;
	colOffset = clamp(colOffset, 0, n - visible);
	const cw = Math.floor((W - (visible - 1)) / visible);
	const bodyH = Math.max(1, H - BODY_TOP - 1);
	const perCol = Math.max(1, Math.floor((bodyH + GAP) / (CARD_H + GAP)));
	return { W, H, visible, cw, bodyH, perCol };
}

function ensureVisible() {
	const col = columns[selCol];
	if (!col) return;
	const { perCol } = layout();
	if (selRow < col.scroll) col.scroll = selRow;
	if (selRow >= col.scroll + perCol) col.scroll = selRow - perCol + 1;
}

function headerLine(W: number, left: string, right: string): string {
	const room = W - width(left) - 1;
	if (room <= 0) return bold(fit(left, W));
	return bold(left) + " ".repeat(Math.max(1, W - width(left) - width(truncate(right, room)))) + dim(truncate(right, room));
}

function cardLines(issue: gh.Issue, cw: number, selected: boolean): string[] {
	const inner = cw - 2;
	const head = `#${issue.number} `;
	const wrapped = wrap(head + clean(issue.title), inner);
	const t1 = wrapped[0] ?? "";
	const t2 = wrapped.length > 2 ? truncate(wrapped.slice(1).join(" "), inner) : (wrapped[1] ?? "");
	const line1 = t1.startsWith(head)
		? fg(CYAN, head) + bold(fit(t1.slice(head.length), inner - width(head)))
		: bold(fit(t1, inner));

	const agent = agentFor(issue);
	const badge = agent ? `◆ ${agent.status} ` : "";
	const columnSet = new Set(columnLabels());
	const meta = [
		...issue.assignees.map(a => `@${a}`),
		...issue.labels.filter(l => !columnSet.has(l)),
		ago(issue.updatedAt),
	].join(" · ");
	const line3 = (agent ? fg(statusColor(agent.status), badge) : "") + dim(fit(meta, inner - width(badge)));

	const pre = selected ? INV : "";
	return [line1, fit(t2, inner), line3].map(l => `${pre} ${l}${pre} ${RESET}`);
}

function renderBoard(L: ReturnType<typeof layout>, rows: string[]) {
	const { W, cw, visible, bodyH, perCol } = L;
	const right = "click/⏎ details · right-click/m actions · i implement · r refresh · q quit";
	rows[0] = headerLine(W, ` ${repo || "…"} · ${issues.length} open`, right);

	const shown = columns.slice(colOffset, colOffset + visible);
	const sep = dim("│");
	const titleParts: string[] = [];
	const ruleParts: string[] = [];
	const bodies: string[][] = [];
	shown.forEach((col, k) => {
		const ci = colOffset + k;
		const x0 = k * (cw + 1);
		const more = col.issues.length - col.scroll - perCol;
		const arrows = `${col.scroll > 0 ? "▲" : ""}${more > 0 ? "▼" : ""}`;
		const title = fit(` ${col.title} (${col.issues.length}) ${arrows}`, cw);
		titleParts.push(ci === selCol ? bold(fg(CYAN, title)) : bold(title));
		titleHits.push({ x0, x1: x0 + cw - 1, y0: 1, y1: 1, col: ci });
		ruleParts.push(dim("─".repeat(cw)));

		const lines: string[] = [];
		if (!col.issues.length) lines.push(dim(fit(loaded ? "  no issues" : "", cw)));
		for (let k2 = 0; k2 < perCol; k2++) {
			const r = col.scroll + k2;
			const issue = col.issues[r];
			if (!issue) break;
			const y0 = BODY_TOP + lines.length;
			cardHits.push({ x0, x1: x0 + cw - 1, y0, y1: y0 + CARD_H - 1, col: ci, row: r });
			lines.push(...cardLines(issue, cw, ci === selCol && r === selRow));
			lines.push(" ".repeat(cw));
		}
		bodies.push(lines);
	});
	rows[1] = titleParts.join(sep);
	rows[2] = ruleParts.join(dim("┼"));
	for (let y = 0; y < bodyH; y++) {
		rows[BODY_TOP + y] = bodies.map(lines => lines[y] ?? " ".repeat(cw)).join(sep);
	}
}

function detailLines(d: Detail, w: number): string[] {
	if (d.error) return [fg(RED, d.error)];
	if (!d.data) return [dim("Loading…")];
	const out = wrap(clean(d.data.body || "(no description)"), w);
	for (const c of d.data.comments) {
		out.push("", fg(CYAN, `── @${c.author} · ${ago(c.createdAt)} ago ──`));
		out.push(...wrap(clean(c.body), w));
	}
	return out;
}

function renderDetail(L: ReturnType<typeof layout>, rows: string[]) {
	const d = detail as Detail;
	const { W, bodyH } = L;
	const right = "esc back · right-click/m actions · o browser · j/k scroll";
	rows[0] = headerLine(W, ` #${d.issue.number} ${clean(d.issue.title)}`, right);
	const meta = [`by @${d.issue.author}`, ...d.issue.assignees.map(a => `@${a}`), ...d.issue.labels, d.issue.url];
	rows[1] = dim(fit(` ${meta.join(" · ")}`, W));
	rows[2] = dim("─".repeat(W));
	const lines = detailLines(d, W - 2);
	d.scroll = clamp(d.scroll, 0, Math.max(0, lines.length - bodyH));
	for (let y = 0; y < bodyH; y++) rows[BODY_TOP + y] = ` ${lines[d.scroll + y] ?? ""}`;
}

function renderMenu(m: Menu, L: ReturnType<typeof layout>): string {
	const labels = m.items.map(it => it.label + (it.submenu ? "  ›" : ""));
	const w = clamp(Math.max(width(m.title) + 6, ...labels.map(l => width(l) + 4)), 10, L.W);
	const h = m.items.length + 2;
	const x = clamp(m.x, 0, L.W - w);
	const y = clamp(m.y, 0, Math.max(0, L.H - h));
	m.x = x;
	m.y = y;
	menuRect = { x0: x, y0: y, x1: x + w - 1, y1: y + h - 1 };
	menuItemRows = [];
	const at = (row: number) => `\x1b[${row + 1};${x + 1}H`;
	const titleText = truncate(` ${m.title} `, w - 4);
	let out = `${at(y)}${RESET}┌─${bold(titleText)}${"─".repeat(Math.max(0, w - 3 - width(titleText)))}┐`;
	m.items.forEach((it, i) => {
		const text = fit(` ${labels[i]}`, w - 2);
		const styled = it.disabled ? dim(text) : i === m.index ? `${INV}${text}${RESET}` : text;
		out += `${at(y + 1 + i)}${RESET}│${styled}│`;
		menuItemRows.push({ y: y + 1 + i, index: i });
	});
	out += `${at(y + h - 1)}${RESET}└${"─".repeat(w - 2)}┘`;
	return out;
}

function render() {
	if (!process.stdout.isTTY) return;
	const L = layout();
	const rows: string[] = new Array(L.H).fill("");
	cardHits = [];
	titleHits = [];
	menuRect = null;
	menuItemRows = [];
	if (detail) renderDetail(L, rows);
	else renderBoard(L, rows);
	const spin = busy ? "⠿ " : "";
	const text = fit(` ${spin}${status.text}`, L.W);
	rows[L.H - 1] = status.color ? fg(status.color, text) : dim(text);

	let frame = "\x1b[?2026h";
	rows.forEach((row, i) => {
		// Clear first: EL after a full-width row would erase its last cell (pending-wrap state).
		frame += `\x1b[${i + 1};1H${RESET}\x1b[2K${row}${RESET}`;
	});
	if (menu) frame += renderMenu(menu, L);
	frame += "\x1b[?2026l";
	process.stdout.write(frame);
}

// ── actions ─────────────────────────────────────────────────────────────────

/** Runs one async operation with status-line feedback; ignores new work while one is running. */
async function act(label: string, fn: () => Promise<string | undefined>) {
	if (busy) return setStatus("Busy, wait for the current action to finish", YELLOW);
	busy = true;
	setStatus(`${label}…`);
	try {
		const done = await fn();
		busy = false;
		setStatus(done ?? `${label}: done`, GREEN);
	} catch (err) {
		busy = false;
		setStatus(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, RED);
	}
}

async function loadIssues(quiet = false) {
	const fetch = async () => {
		[repo, issues] = await Promise.all([repo ? repo : gh.repoName(repoCwd), gh.listIssues(repoCwd)]);
		loaded = true;
		buildColumns();
		ensureVisible();
		return `${issues.length} open issues · ${new Date().toLocaleTimeString()}`;
	};
	if (quiet) {
		try {
			await fetch();
			render();
		} catch {}
		return;
	}
	await act("Loading issues", fetch);
}

async function refreshAgents() {
	try {
		agents = await hd.listAgents();
		render();
	} catch {}
}

function uniqueAgentName(issue: gh.Issue): string {
	const taken = new Set(agents.map(a => a.name));
	const base = `issue-${issue.number}`;
	if (!taken.has(base)) return base;
	for (let k = 2; ; k++) if (!taken.has(`${base}-${k}`)) return `${base}-${k}`;
}

function promptFor(kind: "implement" | "refine", issue: gh.Issue, branch = "") {
	return fill(config.prompts[kind], { number: issue.number, title: issue.title, repo, url: issue.url, branch });
}

/** Starts a named agent in `pane`, sends the prompt, and jumps to it. */
async function launch(issue: gh.Issue, pane: string, prompt: string): Promise<string> {
	agents = await hd.listAgents();
	const name = uniqueAgentName(issue);
	await hd.startAgent(name, config.agent, pane);
	await hd.promptAgent(name, prompt);
	await refreshAgents();
	await hd.focusAgent(name);
	return `Started ${name} (${config.agent}) in ${pane}`;
}

function implementInWorktree(issue: gh.Issue) {
	return act(`Creating worktree for #${issue.number}`, async () => {
		const branch = `issue/${issue.number}-${slug(issue.title)}`;
		const pane = await hd.createWorktree(repoCwd, branch, `#${issue.number} ${truncate(issue.title, 24)}`);
		const prompt = `${promptFor("implement", issue, branch)} You are in a fresh git worktree on branch \`${branch}\`.`;
		return launch(issue, pane, prompt);
	});
}

function launchInSplit(issue: gh.Issue, kind: "implement" | "refine") {
	return act(`Starting agent for #${issue.number}`, async () => {
		if (!originPane) throw new Error("no origin pane to split (open the board via its action)");
		const pane = await hd.splitPane(originPane, repoCwd);
		return launch(issue, pane, promptFor(kind, issue));
	});
}

function sendToAgent(issue: gh.Issue, agent: hd.AgentInfo) {
	return act(`Sending #${issue.number} to ${agent.target}`, async () => {
		await hd.promptAgent(agent.target, promptFor("implement", issue));
		return `Sent #${issue.number} to ${agent.target}`;
	});
}

function moveTo(issue: gh.Issue, target: ColumnSpec | null) {
	return act(`Moving #${issue.number}`, async () => {
		const remove = issue.labels.filter(l => columnLabels().includes(l) && l !== target?.label);
		await gh.relabel(repoCwd, issue.number, target && !issue.labels.includes(target.label) ? target.label : null, remove);
		issue.labels = [...issue.labels.filter(l => !remove.includes(l)), ...(target ? [target.label] : [])];
		buildColumns();
		ensureVisible();
		void loadIssues(true);
		return `Moved #${issue.number} to ${target?.title ?? "No status"}`;
	});
}

function openDetail(issue: gh.Issue) {
	const d: Detail = { issue, data: null, error: null, scroll: 0 };
	detail = d;
	menu = null;
	render();
	gh.issueDetail(repoCwd, issue.number).then(
		data => {
			d.data = data;
			render();
		},
		err => {
			d.error = err instanceof Error ? err.message : String(err);
			render();
		},
	);
}

function openBrowser(issue: gh.Issue) {
	return act(`Opening #${issue.number}`, async () => {
		await gh.openInBrowser(repoCwd, issue.number);
		return `Opened ${issue.url}`;
	});
}

function issueMenu(issue: gh.Issue): MenuItem[] {
	return [
		{ label: "Implement in new worktree", run: () => implementInWorktree(issue) },
		{ label: "Implement in split pane", run: () => launchInSplit(issue, "implement") },
		{ label: "Refine ticket with agent", run: () => launchInSplit(issue, "refine") },
		{
			label: "Send to running agent",
			submenu: async () => {
				const live = await hd.listAgents();
				if (!live.length) return [{ label: "No running agents", disabled: true }];
				live.sort((a, b) => Number(b.cwd.startsWith(repoCwd)) - Number(a.cwd.startsWith(repoCwd)));
				return live.map(a => ({
					label: `${a.target} · ${a.kind} · ${a.status}${a.title ? ` · ${truncate(a.title, 36)}` : ""}`,
					disabled: a.status === "blocked",
					run: () => sendToAgent(issue, a),
				}));
			},
		},
		{
			label: "Move to",
			submenu: () =>
				[null, ...config.columns].map(spec => ({
					label: spec?.title ?? "No status",
					disabled: (spec ? issue.labels.includes(spec.label) : !issue.labels.some(l => columnLabels().includes(l))),
					run: () => moveTo(issue, spec),
				})),
		},
		{ label: "View details", run: () => openDetail(issue) },
		{ label: "Open in browser", run: () => openBrowser(issue) },
	];
}

function firstEnabled(items: MenuItem[], from = 0, step = 1): number {
	for (let k = 0; k < items.length; k++) {
		const i = (((from + k * step) % items.length) + items.length) % items.length;
		if (!items[i].disabled) return i;
	}
	return 0;
}

function openMenu(issue: gh.Issue, x: number, y: number) {
	const items = issueMenu(issue);
	menu = { title: `#${issue.number}`, items, index: firstEnabled(items), x, y, parent: null };
	render();
}

/** Keyboard-opened menus anchor beside the selected card (or near the top in detail view). */
function openMenuAtSelection() {
	const issue = detail?.issue ?? selectedIssue();
	if (!issue) return;
	const hit = cardHits.find(h => h.col === selCol && h.row === selRow);
	openMenu(issue, hit ? hit.x0 + 4 : 2, hit ? hit.y0 + 1 : BODY_TOP);
}

async function activate(m: Menu, index: number) {
	const item = m.items[index];
	if (!item || item.disabled) return;
	if (item.submenu) {
		const items = await item.submenu();
		const w = menuRect ? menuRect.x1 - menuRect.x0 + 1 : 0;
		menu = { title: item.label, items, index: firstEnabled(items), x: m.x + w - 2, y: m.y + index + 1, parent: m };
		return render();
	}
	menu = null;
	render();
	await item.run?.();
}

// ── input ───────────────────────────────────────────────────────────────────

function moveSel(dc: number, dr: number) {
	if (!columns.length) return;
	if (dc) {
		selCol = clamp(selCol + dc, 0, columns.length - 1);
		const col = columns[selCol];
		selRow = clamp(selRow, 0, Math.max(0, col.issues.length - 1));
		// Keep the selection in the visible window rather than jumping to a stale row.
		if (selRow < col.scroll || selRow >= col.scroll + layout().perCol) selRow = clamp(col.scroll, 0, Math.max(0, col.issues.length - 1));
	}
	if (dr) selRow = clamp(selRow + dr, 0, Math.max(0, columns[selCol].issues.length - 1));
	ensureVisible();
	render();
}

function onKey(key: string) {
	if (key === "ctrl-c") return quit();
	if (menu) {
		const m = menu;
		if (key === "up" || key === "k") m.index = firstEnabled(m.items, m.index - 1, -1);
		else if (key === "down" || key === "j") m.index = firstEnabled(m.items, m.index + 1, 1);
		else if (key === "enter" || key === "right" || key === "l" || key === " ") return void activate(m, m.index);
		else if (key === "esc" || key === "left" || key === "h" || key === "q") menu = m.parent;
		return render();
	}
	if (detail) {
		const page = Math.max(1, layout().bodyH - 2);
		if (key === "esc" || key === "q" || key === "backspace" || key === "h" || key === "left") detail = null;
		else if (key === "down" || key === "j") detail.scroll++;
		else if (key === "up" || key === "k") detail.scroll--;
		else if (key === "pgdn" || key === " ") detail.scroll += page;
		else if (key === "pgup") detail.scroll -= page;
		else if (key === "g" || key === "home") detail.scroll = 0;
		else if (key === "G" || key === "end") detail.scroll = Number.MAX_SAFE_INTEGER;
		else if (key === "m" || key === ".") return openMenuAtSelection();
		else if (key === "o") return void openBrowser(detail.issue);
		else if (key === "i") return void implementInWorktree(detail.issue);
		return render();
	}
	const issue = selectedIssue();
	switch (key) {
		case "q":
		case "esc":
			return quit();
		case "left":
		case "h":
			return moveSel(-1, 0);
		case "right":
		case "l":
			return moveSel(1, 0);
		case "up":
		case "k":
			return moveSel(0, -1);
		case "down":
		case "j":
			return moveSel(0, 1);
		case "pgup":
			return moveSel(0, -layout().perCol);
		case "pgdn":
			return moveSel(0, layout().perCol);
		case "g":
		case "home":
			return moveSel(0, -Number.MAX_SAFE_INTEGER);
		case "G":
		case "end":
			return moveSel(0, Number.MAX_SAFE_INTEGER);
		case "r":
			return void loadIssues();
		case "enter":
			return issue && openDetail(issue);
		case "m":
		case ".":
		case " ":
			return openMenuAtSelection();
		case "o":
			return issue && void openBrowser(issue);
		case "i":
			return issue && void implementInWorktree(issue);
	}
}

const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

function onMouse(button: number, x: number, y: number) {
	if (button & 32) return; // motion
	const wheel = button & 64 ? (button & 1 ? 1 : -1) : 0;
	const btn = button & 3;

	if (wheel) {
		if (menu) return;
		if (detail) {
			detail.scroll += wheel * 3;
			return render();
		}
		const hit = titleHits.find(h => x >= h.x0 && x <= h.x1);
		const col = hit && columns[hit.col];
		if (!col) return;
		col.scroll = clamp(col.scroll + wheel, 0, Math.max(0, col.issues.length - layout().perCol));
		return render();
	}

	if (menu) {
		if (menuRect && inside(menuRect, x, y)) {
			const row = menuItemRows.find(r => r.y === y);
			if (row) {
				menu.index = row.index;
				void activate(menu, row.index);
			}
			return;
		}
		menu = null;
		if (btn !== 2) return render();
	}

	if (detail) {
		if (btn === 2) openMenu(detail.issue, x, y);
		return;
	}

	const title = titleHits.find(h => inside(h, x, y));
	if (title) return moveSel(title.col - selCol, 0);
	const card = cardHits.find(h => inside(h, x, y));
	if (!card) return render();
	const issue = columns[card.col].issues[card.row];
	const wasSelected = card.col === selCol && card.row === selRow;
	selCol = card.col;
	selRow = card.row;
	if (btn === 2) return openMenu(issue, x, y);
	if (btn === 0 && wasSelected) return openDetail(issue);
	render();
}

function csiKey(params: string, final: string): string {
	if (final === "~") return { "1": "home", "4": "end", "5": "pgup", "6": "pgdn", "7": "home", "8": "end" }[params.split(";")[0]] ?? "";
	return { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab" }[final] ?? "";
}

function onData(data: string) {
	let i = 0;
	while (i < data.length) {
		const rest = data.slice(i);
		let m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
		if (m) {
			if (m[4] === "M") onMouse(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
			i += m[0].length;
			continue;
		}
		m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest) ?? /^\x1bO()([A-Z])/.exec(rest);
		if (m) {
			onKey(csiKey(m[1], m[2]));
			i += m[0].length;
			continue;
		}
		if (rest[0] === "\x1b") {
			onKey("esc");
			i += rest[1] && rest[1] !== "\x1b" ? 2 : 1; // drop alt+key's key
			continue;
		}
		const ch = String.fromCodePoint(rest.codePointAt(0) ?? 0);
		i += ch.length;
		const named: Record<string, string> = { "\r": "enter", "\n": "enter", "\x03": "ctrl-c", "\x7f": "backspace", "\x08": "backspace" };
		onKey(named[ch] ?? ch);
	}
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function quit(): never {
	process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.exit(0);
}

config = await loadConfig();
buildColumns();
if (selfPane) hd.routeRightClickToPane(selfPane).catch(() => {});
process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J");
process.stdin.setRawMode(true);
process.stdin.on("data", (buf: Buffer) => onData(buf.toString("utf8")));
process.stdout.on("resize", () => {
	ensureVisible();
	render();
});
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);
render();
void loadIssues();
void refreshAgents();
setInterval(refreshAgents, 3000);
setInterval(() => void loadIssues(true), 120_000);
