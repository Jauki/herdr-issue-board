import type { Issue } from "./github";

/**
 * Parses a selection spec against the open issues.
 * `183-192`, `183,185`, `#183`, `all`, `none`, `label:bug`, `@jauki`, or a title substring.
 */
export function parseSelectionSpec(spec: string, issues: Issue[]): { numbers: number[]; note: string } {
	const text = spec.trim();
	if (!text || text === "none" || text === "clear") return { numbers: [], note: "selection cleared" };
	if (text === "all" || text === "*") return { numbers: issues.map(i => i.number), note: `selected all ${issues.length} tickets` };

	const numbers = new Set<number>();
	const known = new Set(issues.map(i => i.number));
	for (const part of text.split(",").map(p => p.trim()).filter(Boolean)) {
		const range = /^#?(\d+)\s*(?:-|\.\.)\s*#?(\d+)$/.exec(part);
		if (range) {
			const [lo, hi] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
			for (const n of known) if (n >= lo && n <= hi) numbers.add(n);
			continue;
		}
		const single = /^#?(\d+)$/.exec(part);
		if (single) {
			if (known.has(Number(single[1]))) numbers.add(Number(single[1]));
			continue;
		}
		const label = /^(?:label:|l:)(.+)$/.exec(part);
		if (label) {
			const want = label[1].trim().toLowerCase();
			for (const i of issues) if (i.labels.some(l => l.toLowerCase() === want)) numbers.add(i.number);
			continue;
		}
		const who = /^@(.+)$/.exec(part);
		if (who) {
			for (const i of issues) if (i.assignees.includes(who[1]) || i.author === who[1]) numbers.add(i.number);
			continue;
		}
		const needle = part.toLowerCase();
		for (const i of issues) if (i.title.toLowerCase().includes(needle)) numbers.add(i.number);
	}

	const sorted = [...numbers].sort((a, b) => a - b);
	if (!sorted.length) return { numbers: [], note: `nothing matched "${text}"` };
	return { numbers: sorted, note: `selected ${sorted.length} of ${issues.length} tickets` };
}

/** `183-192` for a sorted run, `183,185,190` otherwise. Used for branch names and comments. */
export function rangeLabel(numbers: number[]): string {
	const sorted = [...numbers].sort((a, b) => a - b);
	if (!sorted.length) return "none";
	const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
	return contiguous ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(",");
}
