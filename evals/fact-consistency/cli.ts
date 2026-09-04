import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { factConsistencyPrompt } from "../../shared/fact-consistency-prompt.js";
import { parseFactConsistencyFindings } from "../../shared/fact-consistency.js";
import { renderPromptPlan } from "../../shared/prompt-plan.js";
import { canonicalJson } from "../../server/canonical-json.js";
import { FACT_CONSISTENCY_EVAL_CASES } from "./fixture.js";
import { scoreFactConsistencyCase } from "./scoring.js";

interface EvalTarget {
  readonly transport: "openai" | "claude-cli";
  readonly model: string;
  readonly endpoint?: string;
  readonly apiKeyEnv?: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const output = required(args, "--output");
  const target = parseTarget(args);
  const cases = [];
  for (const fixture of FACT_CONSISTENCY_EVAL_CASES) {
    const marker = `[[fact-consistency-complete-${randomUUID().slice(0, 8)}]]`;
    const prompt = factConsistencyPrompt(fixture.part, fixture.part.facts, marker);
    const messages = renderPromptPlan(prompt);
    const raw = target.transport === "openai"
      ? await runOpenAi(target, messages)
      : await runClaudeCli(target, messages);
    const parsed = parseFactConsistencyFindings(
      raw,
      fixture.part.text,
      fixture.part.facts,
      marker
    );
    cases.push({
      id: fixture.id,
      promptSha256: sha256(canonicalJson(messages)),
      complete: parsed.complete,
      ...scoreFactConsistencyCase(fixture, parsed.findings, parsed.droppedFindings)
    });
  }
  const totals = cases.reduce(
    (sum, item) => ({
      found: sum.found + item.found,
      missed: sum.missed + item.missed,
      unexpected: sum.unexpected + item.unexpected,
      dropped: sum.dropped + item.dropped,
      incomplete: sum.incomplete + (item.complete ? 0 : 1)
    }),
    { found: 0, missed: 0, unexpected: 0, dropped: 0, incomplete: 0 }
  );
  await writeFile(output, `${canonicalJson({
    schemaVersion: 1,
    harness: "fact-consistency-v1",
    createdAt: new Date().toISOString(),
    target: { transport: target.transport, model: target.model },
    cases,
    totals
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function parseTarget(args: readonly string[]): EvalTarget {
  const transport = required(args, "--transport");
  if (transport !== "openai" && transport !== "claude-cli") {
    throw new Error("--transport must be openai or claude-cli");
  }
  const model = required(args, "--model");
  if (transport === "claude-cli") return { transport, model };
  return {
    transport,
    model,
    endpoint: required(args, "--endpoint"),
    apiKeyEnv: optional(args, "--api-key-env")
  };
}

async function runOpenAi(
  target: EvalTarget,
  messages: readonly { readonly role: string; readonly content: string }[]
): Promise<string> {
  const endpoint = target.endpoint!;
  const key = target.apiKeyEnv === undefined ? undefined : process.env[target.apiKeyEnv];
  if (target.apiKeyEnv !== undefined && key === undefined) {
    throw new Error(`${target.apiKeyEnv} is not set`);
  }
  const response = await fetch(`${endpoint.replace(/\/$/u, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` })
    },
    body: JSON.stringify({
      model: target.model,
      messages,
      max_tokens: 1024,
      temperature: 0.2,
      stream: false
    })
  });
  if (!response.ok) throw new Error(`model request failed with HTTP ${response.status}`);
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("model response has no text");
  return text;
}

async function runClaudeCli(
  target: EvalTarget,
  messages: readonly { readonly role: string; readonly content: string }[]
): Promise<string> {
  const input = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", [
      "-p", "--model", target.model,
      "--permission-mode", "plan",
      "--permission-prompts", "none",
      "--no-session-persistence"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited ${code ?? "without a status"}: ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required(args: readonly string[], name: string): string {
  const value = optional(args, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function optional(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} must have a value`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`fact consistency eval: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
