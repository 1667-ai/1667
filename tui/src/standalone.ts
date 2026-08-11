export {};

const argv = process.argv.slice(2);
if (argv[0] === "--supervised-serve-child") {
  try {
    const { runSupervisedServeChildBootstrap } = await import(
      "../../server/supervised-serve-child-bootstrap.js"
    );
    await runSupervisedServeChildBootstrap(argv.slice(1));
  } catch (error) {
    sendPrivateFatal(error);
    process.exitCode = 1;
  }
} else if (argv[0] === "--normalize-image-child") {
  try {
    const { runImageNormalizeChildBootstrap } = await import(
      "../../server/image-normalize-child.js"
    );
    await runImageNormalizeChildBootstrap(argv.slice(1));
  } catch (error) {
    sendPrivateFatal(error);
    process.exitCode = 1;
  }
} else if (argv[0] === "serve" && !argv.includes("--legacy-v1")) {
  try {
    const { runServeSupervisor } = await import("./serve-supervisor.js");
    await runServeSupervisor(argv);
  } catch (error) {
    process.stderr.write(`1667 serve: ${boundedMessage(error)}\n`);
    if (error instanceof Error && error.name === "ServeUsageError") {
      process.stderr.write("Try '1667 serve --help'.\n");
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
  }
} else {
  const { runCli } = await import("./main.js");
  await runCli(argv);
}

function sendPrivateFatal(error: unknown): void {
  const child = process as NodeJS.Process & {
    send?: (message: { readonly type: "fatal"; readonly message: string }) => boolean;
  };
  try {
    child.send?.({ type: "fatal", message: boundedMessage(error) });
  } catch {
    // The private child has no public stderr contract.
  }
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 1_000)
    || "unknown startup failure";
}
