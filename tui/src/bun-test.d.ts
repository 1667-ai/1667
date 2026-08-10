declare module "bun:test" {
  export function describe(name: string, body: () => void): void;
  export function test(name: string, body: () => void | Promise<void>, timeout?: number): void;
  export function afterEach(body: () => void | Promise<void>): void;
  export function expect(value: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toMatchObject(expected: object): void;
    toThrow(expected?: string | RegExp): void;
    toBeTrue(): void;
    toBeFalse(): void;
    toBeNull(): void;
    toMatch(expected: string | RegExp): void;
    toBeGreaterThan(expected: number): void;
    toBeDefined(): void;
    toBeLessThan(expected: number): void;
    not: { toContain(expected: unknown): void; toBe(expected: unknown): void; toBeNull(): void };
  };
}

declare const Bun: {
  spawnSync(command: string[], options: { stdin: "inherit"; stdout: "inherit"; stderr: "inherit" }): { exitCode: number };
};
