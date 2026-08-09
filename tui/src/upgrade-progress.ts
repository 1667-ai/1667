import type {
  PackageDownloadProgress,
  PackageDownloadProgressHandler
} from "./upgrade-download.js";

const MAX_BAR_WIDTH = 24;

/** Render one in-place download bar. The caller owns terminal detection. */
export function createUpgradeProgressRenderer(
  write: (text: string) => void,
  columns = 80
): PackageDownloadProgressHandler {
  const availableColumns = Math.max(8, Math.floor(columns));
  let previousWidth = 0;
  return (progress) => {
    const line = progressLine(progress, availableColumns);
    const padding = " ".repeat(Math.max(0, previousWidth - line.length));
    const ended = progress.state !== "active";
    write(`\r${line}${padding}${ended ? "\n" : ""}`);
    previousWidth = ended ? 0 : line.length;
  };
}

function progressLine(progress: PackageDownloadProgress, columns: number): string {
  const total = progress.totalBytes;
  const complete = progress.state === "complete";
  const percent = total === null
    ? complete ? "100%" : ""
    : `${Math.round(Math.min(1, progress.downloadedBytes / total) * 100)}%`;
  const label = columns >= 24 ? "Downloading " : "";
  const suffix = percent.length > 0 ? ` ${percent}` : "";
  const barWidth = Math.max(
    1,
    Math.min(MAX_BAR_WIDTH, columns - label.length - suffix.length - 2)
  );

  if (total === null) {
    const filled = complete
      ? barWidth
      : Math.min(barWidth - 1, Math.floor(progress.downloadedBytes / 65_536) % barWidth);
    const bar = complete
      ? "#".repeat(barWidth)
      : `${"#".repeat(filled)}>${".".repeat(barWidth - filled - 1)}`;
    return `${label}[${bar}]${suffix}`;
  }

  const ratio = Math.min(1, progress.downloadedBytes / total);
  const filled = Math.round(barWidth * ratio);
  const bar = `${"#".repeat(filled)}${".".repeat(barWidth - filled)}`;
  return `${label}[${bar}]${suffix}`;
}
