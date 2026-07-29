import { load, type LibraryHandle } from "koffi";
import { posixLibcCandidates } from "./posix-libc.js";

export function loadNodePosixLibc(
  requiredSymbol: string,
  errorMessage: string
): LibraryHandle {
  let lastError: unknown;
  for (const candidate of posixLibcCandidates(
    process.platform,
    process.arch
  )) {
    let library: LibraryHandle | undefined;
    try {
      library = load(candidate);
      library.symbol(requiredSymbol);
      return library;
    } catch (error) {
      library?.unload();
      lastError = error;
    }
  }
  throw new Error(errorMessage, { cause: lastError });
}
