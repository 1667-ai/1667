#!/usr/bin/env -S node --import tsx

import { packageTarget } from "./package-target.js";

const target = process.env.DESKTOP_TARGET;
if (target === undefined) {
  throw new Error("DESKTOP_TARGET is required; package one target per release runner");
}
packageTarget(target as Parameters<typeof packageTarget>[0]);
