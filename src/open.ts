// Action entrypoint: opens the board pane for the repo of the pane that had focus when invoked.
import { openBoardPane } from "./herdr";

const ctx: Record<string, unknown> = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
const optStr = (v: unknown) => (typeof v === "string" ? v : undefined);
const cwd = optStr(ctx.focused_pane_cwd) ?? optStr(ctx.workspace_cwd);
const origin = optStr(ctx.focused_pane_id);

if (!cwd) {
	console.error("issue-board: no focused pane cwd in plugin context");
	process.exit(1);
}

await openBoardPane({ ISSUE_BOARD_CWD: cwd, ...(origin ? { ISSUE_BOARD_ORIGIN_PANE: origin } : {}) });
