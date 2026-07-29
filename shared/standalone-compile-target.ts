import type { BuiltArtifactTarget } from "./release-targets.js";

export type StandaloneCompileTarget =
  | "bun-darwin-x64-baseline"
  | "bun-linux-x64-baseline";

export interface StandaloneBuildConfiguration {
  readonly entrypoints: string[];
  readonly compile: {
    readonly outfile: string;
    readonly autoloadBunfig?: boolean;
    readonly autoloadDotenv?: boolean;
    readonly target?: StandaloneCompileTarget;
  };
  readonly define?: Readonly<Record<string, string>>;
  readonly external?: string[];
  readonly minify?: boolean;
}

export interface StandaloneCompiler<Result> {
  product(configuration: StandaloneBuildConfiguration): Promise<Result>;
  promptTokenizerSmoke(
    configuration: StandaloneBuildConfiguration
  ): Promise<Result>;
}

const STANDALONE_COMPILE_TARGETS = {
  "darwin-arm64": undefined,
  "darwin-x64": "bun-darwin-x64-baseline",
  "linux-arm64": undefined,
  "linux-x64": "bun-linux-x64-baseline",
  "windows-x64": undefined
} as const satisfies Readonly<
  Record<BuiltArtifactTarget, StandaloneCompileTarget | undefined>
>;

export function standaloneCompileTarget(
  artifactTarget: BuiltArtifactTarget
): StandaloneCompileTarget | undefined {
  return STANDALONE_COMPILE_TARGETS[artifactTarget];
}

export function createStandaloneCompiler<Result>(
  artifactTarget: BuiltArtifactTarget,
  build: (configuration: StandaloneBuildConfiguration) => Promise<Result>
): StandaloneCompiler<Result> {
  return Object.freeze({
    product: (configuration: StandaloneBuildConfiguration) => {
      return build(withStandaloneCompileTarget(artifactTarget, configuration));
    },
    promptTokenizerSmoke: (configuration: StandaloneBuildConfiguration) => {
      return build(withStandaloneCompileTarget(artifactTarget, configuration));
    }
  });
}

function withStandaloneCompileTarget(
  artifactTarget: BuiltArtifactTarget,
  configuration: StandaloneBuildConfiguration
): StandaloneBuildConfiguration {
  const target = standaloneCompileTarget(artifactTarget);
  return {
    ...configuration,
    compile: target === undefined
      ? { ...configuration.compile }
      : { ...configuration.compile, target }
  };
}
