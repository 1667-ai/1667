import { publishDirectoryNoReplaceNative } from "./directory-no-replace.js";

const [source, target, ...extra] = process.argv.slice(2);
if (source === undefined || target === undefined || extra.length > 0) {
  throw new Error(
    "Atomic no-replace directory publication requires source and target"
  );
}

await publishDirectoryNoReplaceNative(source, target);
