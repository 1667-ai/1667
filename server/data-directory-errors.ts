import { ServiceError } from "./errors.js";

export function lockedDataDirectoryError(): ServiceError {
  return new ServiceError(
    409,
    "1667 data is already open by another backend. Stop it and retry; connect with "
      + "1667 --url <owning-server-url> using that backend's printed URL; "
      + "or initialize another absent target with "
      + "1667 --data <absolute-absent-path> --initialize-new --offline-exclusive."
  );
}
