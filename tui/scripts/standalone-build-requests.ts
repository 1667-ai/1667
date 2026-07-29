import type { BuildIdentity } from "../../shared/build-identity.js";
import type {
  StandaloneCompiler
} from "../../shared/standalone-compile-target.js";

export interface StandaloneProductBuildOptions {
  readonly entrypoints: string[];
  readonly outputFile: string;
  readonly buildIdentity: BuildIdentity;
  readonly tiktokenWasmBase64: string;
  readonly embeddedWorkerSource: string | undefined;
}

export interface PromptTokenizerBuildOptions {
  readonly entrypoint: string;
  readonly outputFile: string;
  readonly tiktokenWasmBase64: string;
}

export function buildStandaloneProduct<Result>(
  compiler: StandaloneCompiler<Result>,
  options: StandaloneProductBuildOptions
): Promise<Result> {
  return compiler.product({
    entrypoints: options.entrypoints,
    compile: {
      outfile: options.outputFile,
      // A trusted executable must not run preload code or absorb backend
      // routing from the directory in which a user launches it.
      autoloadBunfig: false,
      autoloadDotenv: false
    },
    define: {
      __AI_1667_BUILD_IDENTITY__: JSON.stringify(options.buildIdentity),
      __AI_1667_TIKTOKEN_WASM_BASE64__: JSON.stringify(
        options.tiktokenWasmBase64
      ),
      __AI_1667_EMBEDDED_WORKER_SOURCE__:
        options.embeddedWorkerSource === undefined
          ? "undefined"
          : JSON.stringify(options.embeddedWorkerSource)
    },
    external: ["koffi"],
    minify: true
  });
}

export function buildPromptTokenizerSmoke<Result>(
  compiler: StandaloneCompiler<Result>,
  options: PromptTokenizerBuildOptions
): Promise<Result> {
  return compiler.promptTokenizerSmoke({
    entrypoints: [options.entrypoint],
    compile: {
      outfile: options.outputFile,
      autoloadBunfig: false,
      autoloadDotenv: false
    },
    define: {
      __AI_1667_TIKTOKEN_WASM_BASE64__: JSON.stringify(
        options.tiktokenWasmBase64
      )
    },
    minify: true
  });
}
