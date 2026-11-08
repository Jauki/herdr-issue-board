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
