export class CommandError extends Error {}

/** Run argv (no shell) and return stdout; throws CommandError with the most useful message on failure. */
export async function run(argv: string[], cwd?: string): Promise<string> {
	const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		const message = stderr.trim() || stdout.trim() || `${argv[0]} exited with ${code}`;
		throw new CommandError(message.split("\n")[0]);
	}
	return stdout;
}

/** Pipes `text` into the platform clipboard: pbcopy (macOS), wl-copy (Wayland) or xclip. */
export async function copyToClipboard(text: string): Promise<void> {
	const argv =
		process.platform === "darwin"
			? ["pbcopy"]
			: process.env.WAYLAND_DISPLAY
				? ["wl-copy"]
				: ["xclip", "-selection", "clipboard"];
	const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
	proc.stdin.write(text);
	proc.stdin.end();
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new CommandError(stderr.trim().split("\n")[0] || `${argv[0]} exited with ${code}`);
}
