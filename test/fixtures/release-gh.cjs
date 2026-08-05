const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const scenario = readScenario(`${process.argv[1]}.scenario.json`);
const tagState = `${scenario.state}.tag`;
fs.appendFileSync(scenario.log, `${JSON.stringify(args)}\n`);

if (args[0] === "api" && args[1].endsWith("/rulesets/20399162")) {
  process.stdout.write(JSON.stringify({
    id: 20399162,
    name: "tag: v* immutable",
    target: "tag",
    updated_at: scenario.rulesetUpdatedAt,
    enforcement: scenario.immutableTagRuleset ? "active" : "disabled",
    ...(scenario.omitBypassActors ? {} : { bypass_actors: [] }),
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }]
  }));
} else if (args[0] === "api" && args[1].includes("/git/ref/tags/")) {
  const sha = fs.existsSync(tagState)
    ? fs.readFileSync(tagState, "utf8")
    : scenario.tagCommit;
  const tag = decodeURIComponent(args[1].split("/").at(-1));
  process.stdout.write(JSON.stringify({
    ref: `refs/tags/${tag}`,
    object: {
      type: scenario.tagObjectSha === null ? "commit" : "tag",
      sha: scenario.tagObjectSha ?? sha
    }
  }));
} else if (args[0] === "api" && args[1].includes("/git/tags/")) {
  const sha = fs.existsSync(tagState)
    ? fs.readFileSync(tagState, "utf8")
    : scenario.tagCommit;
  process.stdout.write(JSON.stringify({
    object: { type: scenario.tagObjectTargetType, sha }
  }));
} else if (args[0] === "api" && args[1].includes("/commits/")) {
  process.stdout.write(JSON.stringify({
    sha: scenario.branchCommit ?? scenario.tagCommit
  }));
} else if (args[1] === "view") {
  viewRelease();
} else if (args[1] === "create") {
  createRelease();
} else if (args[1] === "upload") {
  uploadAssets();
} else if (args[1] === "download") {
  downloadAssets();
} else if (args[1] === "edit") {
  editRelease();
} else if (args[1] === "delete") {
  fs.rmSync(scenario.remote, { recursive: true, force: true });
  fs.rmSync(scenario.state, { force: true });
} else {
  process.stderr.write(`unsupported ${args.join(" ")}\n`);
  process.exit(2);
}

function viewRelease() {
  if (!fs.existsSync(scenario.state)) {
    process.stderr.write("release not found\n");
    process.exit(1);
  }
  const current = JSON.parse(fs.readFileSync(scenario.state, "utf8"));
  const jsonIndex = args.indexOf("--json");
  const fields = jsonIndex === -1 ? [] : args[jsonIndex + 1].split(",");
  const output = {};
  for (const field of fields) {
    if (field === "assets") {
      output.assets = fs.existsSync(scenario.remote)
        ? fs.readdirSync(scenario.remote).map((name) => ({ name }))
        : [];
    } else if (Object.hasOwn(current, field)) {
      output[field] = current[field];
    }
  }
  process.stdout.write(JSON.stringify(output));
}

function createRelease() {
  copyCommandAssets();
  const prerelease = scenario.createdPrerelease ?? args.includes("--prerelease");
  const title = args[args.indexOf("--title") + 1];
  const notes = fs.readFileSync(args[args.indexOf("--notes-file") + 1], "utf8");
  fs.writeFileSync(scenario.state, JSON.stringify({
    body: notes,
    isDraft: true,
    isImmutable: false,
    isPrerelease: prerelease,
    name: title
  }));
}

function uploadAssets() {
  copyCommandAssets();
}

function copyCommandAssets() {
  fs.mkdirSync(scenario.remote, { recursive: true });
  for (const file of args.slice(3)) {
    if (file.startsWith("--")) break;
    fs.copyFileSync(file, path.join(scenario.remote, path.basename(file)));
  }
}

function downloadAssets() {
  const destination = args[args.indexOf("--dir") + 1];
  for (const name of fs.readdirSync(scenario.remote)) {
    fs.copyFileSync(
      path.join(scenario.remote, name),
      path.join(destination, name)
    );
  }
  if (scenario.moveTagAfterDownloadTo !== null) {
    fs.writeFileSync(tagState, scenario.moveTagAfterDownloadTo);
  }
}

function editRelease() {
  const current = JSON.parse(fs.readFileSync(scenario.state, "utf8"));
  fs.writeFileSync(scenario.state, JSON.stringify({
    ...current,
    ...(scenario.tamperBodyOnEdit ? { body: "tampered during publication\n" } : {}),
    isDraft: false,
    isImmutable: true
  }));
  if (scenario.failEditAfterWrite) {
    process.stderr.write("ambiguous edit failure\n");
    process.exit(1);
  }
}

function readScenario(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = [
    "branchCommit",
    "createdPrerelease",
    "failEditAfterWrite",
    "immutableTagRuleset",
    "log",
    "moveTagAfterDownloadTo",
    "omitBypassActors",
    "remote",
    "rulesetUpdatedAt",
    "schemaVersion",
    "state",
    "tagCommit",
    "tagObjectSha",
    "tagObjectTargetType",
    "tamperBodyOnEdit"
  ];
  if (!isRecord(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) {
    throw new Error("Fake GitHub scenario has invalid fields");
  }
  const nullableStrings = [
    "branchCommit",
    "moveTagAfterDownloadTo",
    "tagObjectSha"
  ];
  const strings = ["log", "remote", "rulesetUpdatedAt", "state", "tagCommit"];
  const booleans = [
    "failEditAfterWrite",
    "immutableTagRuleset",
    "omitBypassActors",
    "tamperBodyOnEdit"
  ];
  if (value.schemaVersion !== 1
    || strings.some((key) => typeof value[key] !== "string")
    || nullableStrings.some((key) => value[key] !== null && typeof value[key] !== "string")
    || booleans.some((key) => typeof value[key] !== "boolean")
    || (value.createdPrerelease !== null && typeof value.createdPrerelease !== "boolean")
    || !["commit", "tag"].includes(value.tagObjectTargetType)) {
    throw new Error("Fake GitHub scenario has invalid values");
  }
  return Object.freeze(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
