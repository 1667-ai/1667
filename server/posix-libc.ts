export function posixLibcCandidates(
  platform: NodeJS.Platform,
  arch: string
): string[] {
  if (platform === "darwin") return ["/usr/lib/libSystem.B.dylib"];
  if (platform !== "linux") return [];
  const muslArch = arch === "x64"
    ? "x86_64"
    : arch === "arm64" ? "aarch64" : arch;
  return [
    "libc.so.6",
    `libc.musl-${muslArch}.so.1`,
    `/lib/ld-musl-${muslArch}.so.1`,
    `/usr/lib/ld-musl-${muslArch}.so.1`
  ];
}
