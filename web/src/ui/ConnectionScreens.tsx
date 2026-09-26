/** Section 5's four non-connected screens, plus the Closed overlay. Each is
 * a small centered card — there is nothing else on screen yet to share space
 * with, except Closed, which overlays the last-known (frozen) UI instead of
 * replacing it. */

export function ConnectingScreen() {
  return (
    <div className="connection-screen">
      <div className="connection-card">
        <p>Connecting to 1667…</p>
      </div>
    </div>
  );
}

export function LockedScreen() {
  return (
    <div className="connection-screen">
      <div className="connection-card">
        <p>Open the address that 1667 web printed in the terminal.</p>
      </div>
    </div>
  );
}

export function FailedScreen({ message }: { readonly message: string }) {
  return (
    <div className="connection-screen">
      <div className="connection-card">
        <p>1667 web could not connect.</p>
        <p className="connection-detail">{message}</p>
      </div>
    </div>
  );
}

export function ClosedOverlay(
  { message, onReconnect }: { readonly message: string; readonly onReconnect: () => void }
) {
  return (
    <div className="connection-overlay" role="alertdialog" aria-modal="true" aria-label="Connection closed">
      <div className="connection-card">
        <p>The connection to 1667 closed.</p>
        <p className="connection-detail">{message}</p>
        <button type="button" className="btn btn-primary" onClick={onReconnect}>Reconnect</button>
      </div>
    </div>
  );
}
