import {
  constants,
  flock,
  lockFileEx,
  unlockFileEx,
  type ErrorCallback
} from "fs-ext-extra-prebuilt";
import type { OsFileLockMode } from "./os-file-lock.js";

const WHOLE_FILE = 0xffff_ffff;

export async function lockFile(
  fd: number,
  mode: OsFileLockMode
): Promise<void> {
  if (process.platform === "win32") {
    return await callbackLock((done) => lockFileEx(
      fd,
      (mode === "exclusive" ? constants.LOCKFILE_EXCLUSIVE_LOCK : 0)
        | constants.LOCKFILE_FAIL_IMMEDIATELY,
      0, 0, WHOLE_FILE, WHOLE_FILE, done
    ));
  }
  await callbackLock((done) => flock(
    fd,
    mode === "exclusive" ? "exnb" : "shnb",
    done
  ));
}

export async function unlockFile(fd: number): Promise<void> {
  if (process.platform === "win32") {
    return await callbackLock((done) => unlockFileEx(fd, 0, 0, WHOLE_FILE, WHOLE_FILE, done));
  }
  await callbackLock((done) => flock(fd, "un", done));
}

function callbackLock(start: (done: ErrorCallback) => void): Promise<void> {
  return new Promise((resolve, reject) => start((error) => error === null ? resolve() : reject(error)));
}
