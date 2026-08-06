import { FactActivationError } from "./fact-metadata.js";

type Predicate = (scalar: string) => boolean;

type Ast =
  | { type: "empty" }
  | { type: "atom"; test: Predicate }
  | { type: "boundary"; positive: boolean }
  | { type: "seq"; items: Ast[] }
  | { type: "alt"; items: Ast[] }
  | { type: "repeat"; item: Ast; min: number; max: number | null };

type State =
  | { type: "consume"; test: Predicate; out: number }
  | { type: "split"; out: number; out1: number }
  | { type: "boundary"; positive: boolean; out: number }
  | { type: "match" };

export interface FactPattern {
  readonly states: readonly State[];
  readonly start: number;
}

export interface FactPatternBudget {
  steps: number;
  exhausted: boolean;
}

/** Compile the deliberately small, bounded Fact pattern language. */
export function compileFactPattern(
  source: string,
  flags: string,
  label = "Fact regex key"
): FactPattern {
  assertFactPatternFlags(flags, label);
  const parser = new Parser(source, flags.includes("i"), flags.includes("s"), label);
  const ast = parser.parse();
  const states: State[] = [];
  const emit = (state: State): number => {
    if (states.length >= 128) {
      throw new FactActivationError(`${label} exceeds the 128-state limit`);
    }
    states.push(state);
    return states.length - 1;
  };
  const compile = (node: Ast, next: number): number => compileNode(node, next, emit, states);
  const match = emit({ type: "match" });
  return { states, start: compile(ast, match) };
}

function assertFactPatternFlags(flags: string, label: string): void {
  const supported = [...flags].every((flag) => flag === "i" || flag === "s");
  if (!supported || new Set(flags).size !== flags.length) {
    throw new FactActivationError(`${label} has unsupported flags; use i and s only`);
  }
}

function compileNode(
  node: Ast,
  next: number,
  emit: (state: State) => number,
  states: State[]
): number {
  switch (node.type) {
    case "empty":
      return next;
    case "atom":
      return emit({ type: "consume", test: node.test, out: next });
    case "boundary":
      return emit({ type: "boundary", positive: node.positive, out: next });
    case "seq":
      return node.items.reduceRight(
        (out, item) => compileNode(item, out, emit, states),
        next
      );
    case "alt":
      return compileAlternation(node.items, next, emit, states);
    case "repeat":
      return compileRepeat(node, next, emit, states);
  }
}

function compileAlternation(
  items: readonly Ast[],
  next: number,
  emit: (state: State) => number,
  states: State[]
): number {
  let out = compileNode(items.at(-1)!, next, emit, states);
  for (let index = items.length - 2; index >= 0; index -= 1) {
    out = emit({
      type: "split",
      out: compileNode(items[index]!, next, emit, states),
      out1: out
    });
  }
  return out;
}

function compileRepeat(
  node: Extract<Ast, { type: "repeat" }>,
  next: number,
  emit: (state: State) => number,
  states: State[]
): number {
  let out = next;
  if (node.max === null) {
    // The loop body returns to this split. The split itself must become the
    // continuation for required repetitions; otherwise `*` matches only
    // empty input and `+` loses its unbounded tail.
    const loop = emit({ type: "split", out: -1, out1: next });
    const body = compileNode(node.item, loop, emit, states);
    states[loop] = { type: "split", out: body, out1: next };
    out = loop;
  } else {
    for (let count = node.max; count > node.min; count -= 1) {
      out = emit({
        type: "split",
        out: compileNode(node.item, out, emit, states),
        out1: out
      });
    }
  }
  for (let count = 0; count < node.min; count += 1) {
    out = compileNode(node.item, out, emit, states);
  }
  return out;
}

/** Return false when the shared deterministic scan budget is exhausted. */
export function factPatternMatches(
  pattern: FactPattern,
  text: string,
  budget: FactPatternBudget,
  precedingScalar: string | null = null
): boolean {
  const scalars = [...text];
  for (let start = 0; start <= scalars.length; start += 1) {
    let current = closure(
      pattern,
      [pattern.start],
      start === 0 ? precedingScalar : scalars[start - 1]!,
      scalars[start] ?? null,
      budget
    );
    if (budget.exhausted) return false;
    if (hasMatch(pattern, current)) return true;
    for (let offset = start; offset < scalars.length; offset += 1) {
      const next = consumeStates(pattern, current, scalars[offset]!, budget);
      if (budget.exhausted) return false;
      current = closure(
        pattern,
        next,
        scalars[offset]!,
        scalars[offset + 1] ?? null,
        budget
      );
      if (budget.exhausted) return false;
      if (hasMatch(pattern, current)) return true;
      if (current.length === 0) break;
    }
  }
  return false;
}

function consumeStates(
  pattern: FactPattern,
  current: readonly number[],
  scalar: string,
  budget: FactPatternBudget
): number[] {
  const next: number[] = [];
  for (const index of current) {
    const state = pattern.states[index]!;
    if (state.type !== "consume") continue;
    if (!spendStep(budget)) return next;
    if (state.test(scalar)) next.push(state.out);
  }
  return next;
}

function closure(
  pattern: FactPattern,
  initial: readonly number[],
  before: string | null,
  after: string | null,
  budget: FactPatternBudget
): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  const queue = [...initial];
  while (queue.length > 0) {
    if (!spendStep(budget)) return result;
    const index = queue.pop()!;
    if (seen.has(index)) continue;
    seen.add(index);
    const state = pattern.states[index]!;
    if (state.type === "split") {
      queue.push(state.out, state.out1);
      continue;
    }
    if (state.type === "boundary") {
      if (state.positive === (isWord(before) !== isWord(after))) {
        queue.push(state.out);
      }
      continue;
    }
    result.push(index);
  }
  return result;
}

function spendStep(budget: FactPatternBudget): boolean {
  if (budget.steps <= 0) {
    budget.exhausted = true;
    return false;
  }
  budget.steps -= 1;
  return true;
}

function hasMatch(pattern: FactPattern, states: readonly number[]): boolean {
  return states.some((index) => pattern.states[index]!.type === "match");
}

function isWord(value: string | null): boolean {
  return value !== null && /^[\p{L}\p{N}\p{M}_]$/u.test(value);
}

class Parser {
  position = 0;
  private groupDepth = 0;
  private readonly characters: readonly string[];

  constructor(
    source: string,
    private readonly insensitive: boolean,
    private readonly dotAll: boolean,
    private readonly label: string
  ) {
    this.characters = [...source];
  }

  parse(): Ast {
    const value = this.alternation();
    if (this.position !== this.characters.length) this.fail();
    return value;
  }

  private alternation(): Ast {
    const items = [this.sequence()];
    while (this.take("|")) items.push(this.sequence());
    return items.length === 1 ? items[0]! : { type: "alt", items };
  }

  private sequence(): Ast {
    const items: Ast[] = [];
    while (this.position < this.characters.length && !"|)".includes(this.peek())) {
      items.push(this.term());
    }
    if (items.length === 0) return { type: "empty" };
    return items.length === 1 ? items[0]! : { type: "seq", items };
  }

  private term(): Ast {
    const atom = this.atom();
    const marker = this.peek();
    if (marker === "?" || marker === "*" || marker === "+") {
      this.position += 1;
      return {
        type: "repeat",
        item: atom,
        min: marker === "+" ? 1 : 0,
        max: marker === "?" ? 1 : null
      };
    }
    if (marker !== "{") return atom;
    this.position += 1;
    const min = this.number();
    let max: number | null = min;
    if (this.take(",")) max = this.peek() === "}" ? null : this.number();
    if (!this.take("}") || min > 8 || (max !== null && (max > 8 || max < min))) {
      this.fail("has invalid repetition bounds");
    }
    return { type: "repeat", item: atom, min, max };
  }

  private atom(): Ast {
    const character = this.peek();
    if (character === "(") return this.group();
    if (character === ".") {
      this.position += 1;
      return { type: "atom", test: (value) => this.dotAll || !isLineBreak(value) };
    }
    if (character === "[") return { type: "atom", test: this.classTest() };
    if (character === "\\") return this.escape();
    if (character === "^" || character === "$") this.fail("does not allow anchors");
    if (")|*+?{".includes(character)) this.fail();
    this.position += 1;
    return { type: "atom", test: this.literal(character) };
  }

  private group(): Ast {
    this.position += 1;
    if (!this.take("?:")) this.fail("does not allow capturing or named groups");
    if (this.groupDepth >= 4) this.fail("exceeds the 4-group nesting limit");
    this.groupDepth += 1;
    try {
      const content = this.alternation();
      if (!this.take(")")) this.fail();
      return content;
    } finally {
      this.groupDepth -= 1;
    }
  }

  private escape(): Ast {
    this.position += 1;
    const character = this.next();
    if (character === "b" || character === "B") {
      return { type: "boundary", positive: character === "b" };
    }
    if (character === "d" || character === "D") {
      return { type: "atom", test: (value) => /[0-9]/u.test(value) === (character === "d") };
    }
    if (character === "w" || character === "W") {
      return { type: "atom", test: (value) => isWord(value) === (character === "w") };
    }
    if (character === "s" || character === "S") {
      return { type: "atom", test: (value) => /\s/u.test(value) === (character === "s") };
    }
    if (character === "p" || character === "P") return this.propertyEscape(character);
    if (character === "u") return { type: "atom", test: this.literal(this.hexScalar()) };
    if (character === "n" || character === "r" || character === "t") {
      return { type: "atom", test: this.literal(controlScalar(character)) };
    }
    if ("\\/.".includes(character)) return { type: "atom", test: this.literal(character) };
    this.fail("has an unsupported escape");
  }

  private propertyEscape(character: "p" | "P"): Ast {
    if (!this.take("{")) this.fail();
    const end = this.characters.indexOf("}", this.position);
    if (end < 0) this.fail();
    const property = this.characters.slice(this.position, end).join("");
    this.position = end + 1;
    let test: RegExp;
    try {
      test = new RegExp(`^\\p{${property}}$`, this.insensitive ? "iu" : "u");
    } catch {
      this.fail("has an invalid Unicode property");
    }
    return { type: "atom", test: (value) => test.test(value) === (character === "p") };
  }

  private classTest(): Predicate {
    this.position += 1;
    const negated = this.take("^");
    const tests: Predicate[] = [];
    let closed = false;
    while (this.position < this.characters.length) {
      if (this.take("]")) {
        closed = true;
        break;
      }
      const first = this.classScalar();
      if (this.peek() === "-" && this.characters[this.position + 1] !== "]") {
        this.position += 1;
        const second = this.classScalar();
        tests.push(this.range(first, second));
      } else {
        tests.push(this.literal(first));
      }
    }
    if (!closed || tests.length === 0) this.fail("has an invalid character class");
    return (value) => tests.some((test) => test(value)) !== negated;
  }

  private range(first: string, second: string): Predicate {
    const lower = this.fold(first);
    const upper = this.fold(second);
    if (lower > upper) this.fail("has a descending character range");
    return (value) => {
      const candidate = this.fold(value);
      return candidate >= lower && candidate <= upper;
    };
  }

  private classScalar(): string {
    if (this.peek() !== "\\") return this.next();
    this.position += 1;
    const character = this.next();
    if (character === "n" || character === "r" || character === "t") {
      return controlScalar(character);
    }
    if (character === "u") return this.hexScalar();
    if ("\\/-]".includes(character)) return character;
    this.fail("has an unsupported character class escape");
  }

  private hexScalar(): string {
    const code = this.characters.slice(this.position, this.position + 4).join("");
    if (!/^[0-9a-f]{4}$/iu.test(code)) this.fail();
    this.position += 4;
    return String.fromCharCode(Number.parseInt(code, 16));
  }

  private literal(value: string): Predicate {
    const expected = this.fold(value);
    return (actual) => this.fold(actual) === expected;
  }

  private fold(value: string): string {
    return this.insensitive ? value.toLowerCase() : value;
  }

  private number(): number {
    const match = /^\d+/u.exec(this.characters.slice(this.position).join(""));
    if (match === null) this.fail();
    this.position += [...match![0]].length;
    return Number(match![0]);
  }

  private peek(): string {
    return this.characters[this.position] ?? "";
  }

  private next(): string {
    const value = this.peek();
    if (value === "") this.fail();
    this.position += 1;
    return value;
  }

  private take(value: string): boolean {
    const characters = [...value];
    if (this.characters.slice(this.position, this.position + characters.length).join("") !== value) {
      return false;
    }
    this.position += characters.length;
    return true;
  }

  private fail(reason = "has invalid pattern syntax"): never {
    throw new FactActivationError(`${this.label} ${reason}`);
  }
}

function controlScalar(value: "n" | "r" | "t"): string {
  return { n: "\n", r: "\r", t: "\t" }[value];
}

function isLineBreak(value: string): boolean {
  return value === "\n" || value === "\r" || value === "\u2028" || value === "\u2029";
}
