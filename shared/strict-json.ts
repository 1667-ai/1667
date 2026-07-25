const MAX_JSON_NESTING = 128;

/** JSON.parse-compatible value parsing with duplicate object keys rejected
 * after escape decoding (`"a"` and `"\u0061"` are the same key). */
export function parseJsonRejectingDuplicateKeys(text: string): unknown {
  try {
    return new StrictJsonParser(text).parse();
  } catch (error) {
    if (error instanceof StrictJsonError) throw error;
    throw new StrictJsonError("invalid JSON", { cause: error });
  }
}

export class StrictJsonError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StrictJsonError";
  }
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("unexpected trailing input");
    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_JSON_NESTING) this.fail(`nesting exceeds ${MAX_JSON_NESTING}`);
    switch (this.text[this.index]) {
      case "{": return this.parseObject(depth + 1);
      case "[": return this.parseArray(depth + 1);
      case "\"": return this.parseString();
      case "t": return this.parseLiteral("true", true);
      case "f": return this.parseLiteral("false", false);
      case "n": return this.parseLiteral("null", null);
      default: return this.parseNumber();
    }
  }

  private parseObject(depth: number): Record<string, unknown> {
    if (depth > MAX_JSON_NESTING) {
      this.fail(`nesting exceeds ${MAX_JSON_NESTING}`);
    }
    this.index += 1;
    this.skipWhitespace();
    const result: Record<string, unknown> = Object.create(null);
    const keys = new Set<string>();
    if (this.consume("}")) return result;
    while (true) {
      if (this.text[this.index] !== "\"") this.fail("object key must be a string");
      const key = this.parseString();
      if (keys.has(key)) this.fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      if (this.consume("}")) return result;
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): unknown[] {
    if (depth > MAX_JSON_NESTING) {
      this.fail(`nesting exceeds ${MAX_JSON_NESTING}`);
    }
    this.index += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.consume("]")) return result;
    while (true) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.consume("]")) return result;
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch (error) {
          throw new StrictJsonError("invalid string", { cause: error });
        }
      }
      if (code < 0x20) this.fail("unescaped control character in string");
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === "u") {
          for (let offset = 1; offset <= 4; offset += 1) {
            if (!/[0-9A-Fa-f]/.test(this.text[this.index + offset] ?? "")) {
              this.fail("invalid Unicode escape");
            }
          }
          this.index += 5;
          continue;
        }
        if (!"\"\\/bfnrt".includes(escape ?? "")) this.fail("invalid escape");
      }
      this.index += 1;
    }
    this.fail("unterminated string");
  }

  private parseNumber(): number {
    const remaining = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining);
    if (match === null) this.fail("expected a JSON value");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("number is outside the finite JSON range");
    return value;
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (!this.text.startsWith(literal, this.index)) this.fail(`expected ${literal}`);
    this.index += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.text[this.index] === " "
      || this.text[this.index] === "\n"
      || this.text[this.index] === "\r"
      || this.text[this.index] === "\t"
    ) {
      this.index += 1;
    }
  }

  private consume(expected: string): boolean {
    if (this.text[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) this.fail(`expected ${expected}`);
  }

  private fail(message: string): never {
    throw new StrictJsonError(`${message} at UTF-16 offset ${this.index}`);
  }
}
