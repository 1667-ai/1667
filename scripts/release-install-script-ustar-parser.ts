/**
 * Render the raw POSIX ustar header parser in the generated Shell Installer.
 * The parser maps exact generated member paths to numeric IDs. It does not
 * return archive paths to the shell.
 */
export function shellInstallerUstarParser(memberCount: number): string {
  if (!Number.isInteger(memberCount) || memberCount < 2 || memberCount > 30) {
    throw new Error("Shell ustar parser member count is outside the supported range");
  }
  const pathVariables = Array.from({ length: memberCount }, (_, id) => {
    return `-v m${id}="\$m${id}"`;
  }).join(" ");
  const fileMappings = Array.from({ length: memberCount - 1 }, (_, index) => {
    const id = index + 1;
    return `      if (path == m${id}) { print "F:${id}:" size; exit 0 }`;
  }).join("\n");

  return `
# Parse one physical 512-byte ustar header.
# Output is one fixed record: zero, bad, layout, D:0, or F:<id>:<size>.
parse_ustar_header() {
  hdr_path=\$1
  od -An -v -tu1 -N512 "\$hdr_path" 9>&- | awk ${pathVariables} '
    {
      for (i = 1; i <= NF; i++) {
        b[n_bytes++] = \$i + 0
      }
    }
    END {
      if (n_bytes != 512) {
        print "bad"
        exit 1
      }
      z = 1
      for (i = 0; i < 512; i++) {
        if (b[i] != 0) {
          z = 0
          break
        }
      }
      if (z) {
        print "zero"
        exit 0
      }
      sum = 0
      for (i = 0; i < 512; i++) {
        if (i >= 148 && i < 156) sum += 32
        else sum += b[i]
      }
      ck = parse_octal(148, 8)
      if (ck < 0 || ck != sum) {
        print "bad"
        exit 1
      }
      if (b[257] != 117 || b[258] != 115 || b[259] != 116 || b[260] != 97 || b[261] != 114 || b[262] != 0) {
        print "bad"
        exit 1
      }
      if (b[263] != 48 || b[264] != 48) {
        print "bad"
        exit 1
      }
      type = b[156]
      mode = parse_octal(100, 8)
      size = parse_octal(124, 12)
      if (mode < 0 || size < 0) {
        print "bad"
        exit 1
      }
      for (i = 157; i < 257; i++) {
        if (b[i] != 0) {
          print "bad"
          exit 1
        }
      }
      name = field_text(0, 100)
      if (name == "__BAD_FIELD__") {
        print "bad"
        exit 1
      }
      prefix = field_text(345, 155)
      if (prefix == "__BAD_FIELD__") {
        print "bad"
        exit 1
      }
      if (name == "" && prefix == "") {
        print "bad"
        exit 1
      }
      if (prefix == "") path = name
      else path = prefix "/" name
      if (type == 0 || type == 48) {
${fileMappings}
        print "layout"
        exit 0
      }
      if (type == 53) {
        if (size != 0) {
          print "bad"
          exit 1
        }
        if (substr(path, length(path), 1) == "/") {
          path = substr(path, 1, length(path) - 1)
        }
        if (path == "") {
          print "bad"
          exit 1
        }
        if (path == m0) {
          print "D:0"
          exit 0
        }
        print "layout"
        exit 0
      }
      print "bad"
      exit 1
    }
    function parse_octal(start, len,   i, end, c, started, v) {
      if (b[start] >= 128) return -1
      end = start + len
      started = 0
      v = 0
      for (i = start; i < end; i++) {
        c = b[i]
        if (c == 0) {
          for (i = i + 1; i < end; i++) {
            if (b[i] != 0 && b[i] != 32) return -1
          }
          break
        }
        if (c == 32) {
          if (!started) continue
          for (i = i + 1; i < end; i++) {
            if (b[i] != 0 && b[i] != 32) return -1
          }
          break
        }
        if (c < 48 || c > 55) return -1
        started = 1
        if (v > 2147483647 / 8) return -1
        v = v * 8 + (c - 48)
      }
      if (!started) return -1
      return v
    }
    function field_text(start, len,   i, end, out, c) {
      end = start + len
      out = ""
      for (i = start; i < end; i++) {
        c = b[i]
        if (c == 0) {
          for (i = i + 1; i < end; i++) {
            if (b[i] != 0) return "__BAD_FIELD__"
          }
          return out
        }
        if (c < 32 || c > 126) return "__BAD_FIELD__"
        out = out sprintf("%c", c)
      }
      return out
    }
  '
}
`;
}
