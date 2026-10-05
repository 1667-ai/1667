import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "react";

/** What a view shows while its chunk downloads, and when the download fails. */
export const CHUNK_LOADING_TEXT = "Loading…";
export const CHUNK_FAILED_TEXT = "This part of the app did not load. Check the connection, then try again.";
export const CHUNK_FAILED_AGAIN_TEXT = "This part of the app still did not load. Reload the page to get it.";

interface BoundaryProps {
  readonly onRetry: () => void;
  readonly onDismiss: (() => void) | undefined;
  readonly floating: boolean;
  readonly children: ReactNode;
}

/** Catches a chunk that failed to load (offline, or a server that restarted
 * with new file names) and offers a retry instead of a blank page. */
class ChunkBoundary extends Component<BoundaryProps, { readonly failed: boolean; readonly failures: number }> {
  override state = { failed: false, failures: 0 };

  static getDerivedStateFromError(): { readonly failed: true } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.setState((state) => ({ failures: state.failures + 1 }));
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { onRetry, onDismiss, floating } = this.props;
    return (
      <div role="alert" className={floating ? "chunk-error chunk-error-floating" : "chunk-error"}>
        <p>{this.state.failures > 1 ? CHUNK_FAILED_AGAIN_TEXT : CHUNK_FAILED_TEXT}</p>
        {/* A browser may keep a failed script download for the life of the
            page, and a restarted server may have new file names: a second
            failure offers a reload, which the unload guard still protects. */}
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (this.state.failures > 1) {
              location.reload();
              return;
            }
            onRetry();
            this.setState({ failed: false });
          }}
        >
          {this.state.failures > 1 ? "Reload page" : "Retry"}
        </button>
        {onDismiss !== undefined && <button type="button" className="btn" onClick={onDismiss}>Close</button>}
      </div>
    );
  }
}

export interface LazyViewOptions {
  /** A dialog or a panel: a failure shows as a small floating message and
   * the loading state shows nothing. */
  readonly floating?: boolean;
}

export type LazyView<P extends object> = ((props: P & { readonly onDismiss?: () => void }) => ReactNode) & {
  /** Starts the download without showing anything. */
  readonly preload: () => void;
};

/**
 * A view whose code downloads when it is first shown. A failed download shows
 * a retry message, and Retry asks the browser for the chunk again. The
 * loader is called again on each retry, so a failed import is never cached.
 */
export function lazyView<P extends object>(
  load: () => Promise<ComponentType<P>>,
  options: LazyViewOptions = {}
): LazyView<P> {
  const floating = options.floating === true;
  const make = () => lazy(async () => ({ default: await load() }));
  let Inner = make();
  const view = ({ onDismiss, ...props }: P & { readonly onDismiss?: () => void }): ReactNode => {
    const Current = Inner as ComponentType<P>;
    return (
      <ChunkBoundary onRetry={() => { Inner = make(); }} onDismiss={onDismiss} floating={floating}>
        <Suspense fallback={floating ? null : <p className="story-empty">{CHUNK_LOADING_TEXT}</p>}>
          <Current {...(props as unknown as P)} />
        </Suspense>
      </ChunkBoundary>
    );
  };
  return Object.assign(view, { preload: () => { void load().catch(() => undefined); } });
}
