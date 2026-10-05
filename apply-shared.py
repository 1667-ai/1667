import os, re, subprocess
R = "/Users/chris/source/1667-web-10"
S = "/private/tmp/claude-501/-Users-chris-source-1667-worktree-session-brisk-wren-jw3x/65fe0758-598d-4332-8d24-4975fc1796e6/scratchpad"
def rd(p): return open(os.path.join(R, p)).read()
def wr(p, t): open(os.path.join(R, p), "w").write(t)
def sub(p, old, new):
    t = rd(p); assert old in t, (p, old[:70]); wr(p, t.replace(old, new, 1))
def run(*a): subprocess.run(a, cwd=R, check=True)

# generation-record-pipeline moves whole
run("git", "mv", "tui/src/generation-record-pipeline.ts", "shared/generation-record-pipeline.ts")
t = rd("shared/generation-record-pipeline.ts"); wr("shared/generation-record-pipeline.ts", t.replace('"../../shared/', '"./'))
run("python3", f"{S}/remap.py", "tui/src/generation-record-pipeline", "shared/generation-record-pipeline")

# probabilityOf moves to the browser-safe wire module
t = rd("shared/token-probabilities.ts")
a = t.index("/** Every displayed probability is derived")
b = t.index("}\n", t.index("export function probabilityOf")) + 2
block = t[a:b]
wr("shared/token-probabilities.ts", t[:a] + t[b:].lstrip("\n"))
sub("shared/token-probabilities.ts", "export { TokenProbabilityFormatError } from \"./token-probability-wire.js\";", "export { probabilityOf, TokenProbabilityFormatError } from \"./token-probability-wire.js\";")
w = rd("shared/token-probability-wire.ts")
wr("shared/token-probability-wire.ts", w.rstrip() + "\n\n" + block)

# token-probabilities-model: the non-wrap part moves
src = rd("tui/src/token-probabilities-model.ts")
ia = src.index("/** UTF-16 span of one step's token")
ib = src.index("export type TokenProbabilityExcerptLine")
span_block = src[ia:ib]
excerpt_start = ib
ic = src.index("/** Why the take has no token probabilities")
excerpt_block = src[ib:ic]
reason_block = src[ic:]
head_end = src.index("/** UTF-16 span of one step's token")
head = src[:head_end]
head = head.replace('"../../shared/', '"./').replace('import { type StyleRun, type WrappedLine, wrapText } from "./wrap.js";\n', '')
shared = head + span_block + reason_block
wr("shared/token-probabilities-model.ts", shared)
tui = '''import type { TokenProbabilityRecord } from "../../shared/token-probabilities.js";
import { type StyleRun, type WrappedLine, wrapText } from "./wrap.js";

// The model of the token probability viewer lives in `shared/` (the web page
// uses it too); only the excerpt, which wraps for the terminal, stays here.
export * from "../../shared/token-probabilities-model.js";

''' + excerpt_block
wr("tui/src/token-probabilities-model.ts", tui)

# request document words
t = rd("tui/src/screens/request-viewer.ts")
def cut(start, end):
    a = t.index(start); b = t.index(end, a); return t[:a] + t[b:]
t = cut("/** `tokens exact`, `tokens near-exact`", "function requestHeader(")
t = cut("function substitutionNotices(", "function requestBody(")
a = t.index("function entrySource(")
t = t[:a].rstrip() + "\n"
t = t.replace('import { imageAttachmentLabel, imageMediaTypeLabel } from "../../../shared/image-attachment.js";', 'import { imageAttachmentLabel, imageMediaTypeLabel } from "../../../shared/image-attachment.js";\nimport {\n  activationNotices,\n  requestEntrySource as entrySource,\n  substitutionNotices,\n  tokenSourceLabel\n} from "../../../shared/request-document-model.js";')
wr("tui/src/screens/request-viewer.ts", t)
d = rd("tui/src/draft-image.ts")
a = d.index("/** `418 KiB`, `2.3 MiB`")
b = d.index("}\n", d.index("export function formatImageBytes")) + 2
wr("tui/src/draft-image.ts", d[:a] + 'export { formatImageBytes } from "../../shared/request-document-model.js";\n' + d[b:])
print("shared moved")
