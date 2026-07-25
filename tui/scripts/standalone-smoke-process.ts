export async function runStandalone(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}> {
  const started = performance.now();
  const child = Bun.spawn(
    [executable, ...args],
    { cwd, env, stdout: "pipe", stderr: "pipe" }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    elapsedMs: performance.now() - started
  };
}
