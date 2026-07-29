const CONCURRENCY_GROUP = /^[A-Za-z0-9_.-]{1,100}$/u;

export interface GitHubConcurrencyAcquisition {
  readonly groupName: string;
  readonly acquiredAt: number;
  readonly observedAt: number;
}

export interface GitHubConcurrencyMember {
  readonly runId: number;
  readonly jobId: number | null;
  readonly jobName: string | null;
  readonly status: string;
}

export function requireConcurrencyGroup(value: string): void {
  if (!CONCURRENCY_GROUP.test(value)) {
    throw new Error("GitHub ref store concurrency group is invalid");
  }
}

export function parseConcurrencyAcquisition(
  pages: readonly unknown[],
  dates: readonly (string | null)[],
  groupName: string
): GitHubConcurrencyAcquisition {
  if (pages.length === 0 || pages.length !== dates.length) {
    throw new Error("GitHub ref store concurrency pagination is invalid");
  }
  const groups: Array<Omit<GitHubConcurrencyAcquisition, "observedAt">> = [];
  let totalCount: number | null = null;
  let observedAt = 0;
  for (const [index, page] of pages.entries()) {
    observedAt = responseTime(dates[index]!, "concurrency groups");
    const record = object(page, "GitHub ref store concurrency groups");
    if (!Number.isSafeInteger(record.total_count)
      || (record.total_count as number) < 0
      || !Array.isArray(record.concurrency_groups)
      || (record.total_count as number) < record.concurrency_groups.length) {
      throw new Error("GitHub ref store returned malformed concurrency groups");
    }
    if (totalCount === null) totalCount = record.total_count as number;
    else if (record.total_count !== totalCount) {
      throw new Error("GitHub ref store concurrency count changed during pagination");
    }
    groups.push(...record.concurrency_groups.map(concurrencyAcquisition));
  }
  if (groups.length !== totalCount) {
    throw new Error("GitHub ref store concurrency pagination is incomplete");
  }
  const matching = groups.filter((group) => group.groupName === groupName);
  if (matching.length !== 1) {
    throw new Error("GitHub ref store concurrency group is not exact");
  }
  const acquisition = matching[0]!;
  if (acquisition.acquiredAt > observedAt + 999) {
    throw new Error("GitHub ref store concurrency acquisition is in the future");
  }
  return Object.freeze({ ...acquisition, observedAt });
}

export function parseConcurrencyMembers(
  value: unknown,
  groupName: string
): readonly GitHubConcurrencyMember[] {
  const record = object(value, "GitHub ref store concurrency group members");
  if (record.group_name !== groupName || !Number.isSafeInteger(record.total_count)
    || !Array.isArray(record.group_members)
    || (record.total_count as number) < record.group_members.length) {
    throw new Error(
      "GitHub ref store returned malformed concurrency group members"
    );
  }
  return Object.freeze(record.group_members.map(concurrencyMember));
}

function concurrencyAcquisition(value: unknown): Omit<
  GitHubConcurrencyAcquisition,
  "observedAt"
> {
  const record = object(value, "GitHub ref store concurrency group");
  if (typeof record.group_name !== "string"
    || typeof record.last_acquired_at !== "string") {
    throw new Error("GitHub ref store returned a malformed concurrency group");
  }
  return Object.freeze({
    groupName: record.group_name,
    acquiredAt: isoTime(
      record.last_acquired_at,
      "GitHub ref store concurrency acquisition"
    )
  });
}

function concurrencyMember(value: unknown): GitHubConcurrencyMember {
  const record = object(value, "GitHub ref store concurrency group member");
  const jobId = record.job_id ?? null;
  const jobName = record.job_name ?? null;
  if (!Number.isSafeInteger(record.run_id)
    || (jobId !== null && !Number.isSafeInteger(jobId))
    || (jobName !== null && typeof jobName !== "string")
    || typeof record.status !== "string") {
    throw new Error(
      "GitHub ref store returned a malformed concurrency group member"
    );
  }
  return Object.freeze({
    runId: record.run_id as number,
    jobId: jobId as number | null,
    jobName,
    status: record.status
  });
}

function responseTime(value: string | null, label: string): number {
  const milliseconds = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)
    || new Date(milliseconds).toUTCString() !== value) {
    throw new Error(`GitHub ref store ${label} has an invalid server time`);
  }
  return milliseconds;
}

function isoTime(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  const canonical = value.includes(".")
    ? new Date(milliseconds).toISOString()
    : new Date(milliseconds).toISOString().replace(".000Z", "Z");
  if (!Number.isSafeInteger(milliseconds) || canonical !== value) {
    throw new Error(`${label} is invalid`);
  }
  return milliseconds;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
