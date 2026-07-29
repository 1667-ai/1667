export async function withCallerCancellation<T>(
  value: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined) return await value;
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason
    ?? new DOMException("Operation canceled", "AbortError");
}
