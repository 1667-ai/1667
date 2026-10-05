import { Component, Suspense, lazy, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { pushKeyLayer } from "../app/keymap.js";

/** What a view shows while its chunk downloads, and when the download fails. */
export const CHUNK_LOADING_TEXT = "Loading…";
export const CHUNK_FAILED_TEXT = "This part of the app did not load. Check the connection, then try again.";

interface BoundaryProps {
  readonly onRetry: () => void;
  readonly onDismiss: (() => void) | undefined;
  readonly floating: boolean;
  readonly children: ReactNode;
}

/** Catches a chunk that failed to load (offline, or a server that restarted
 * with new file names) and offers a retry instead of a blank page. */
class ChunkBoundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: true } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { onRetry, onDismiss, floating } = this.props;
    return (
      <div role="alert" className={floating ? "chunk-error chunk-error-floating" : "chunk-error"}>
        <p>{CHUNK_FAILED_TEXT}</p>
        <button type="button" className="btn" onClick={onRetry}>Retry</button>
        {/* A restarted server has new file names: only a reload finds them. */}
        <button type="button" className="btn" onClick={() => location.reload()}>Reload page</button>
        {onDismiss !== undefined && <button type="button" className="btn" onClick={onDismiss}>Close</button>}
      </div>
    );
  }
}

/** While a view downloads, keys must not reach the page behind it as
 * shortcuts: a printable key would act on the story. They are held back, and
 * Esc dismisses the pending view. */
function HoldKeys({ onDismiss }: { readonly onDismiss: (() => void) | undefined }) {
  useEffect(() => pushKeyLayer({
    claimsEscape: true,
    resolve: (event) => (event.metaKey || event.ctrlKey || event.altKey
      ? null
      : { display: event.key, lane: "nav", name: event.key, mode: "NAV", action: event.key === "Escape" ? "cancel" : "hold" } as never),
    handle: (key) => {
      if (key.action !== "cancel") return true;
      if (onDismiss === undefined) return false;
      onDismiss();
      return true;
    }
  }), [onDismiss]);
  return null;
}

export interface LazyViewOptions {
  /** A dialog or a panel: a failure shows as a small floating message and
   * the loading state shows nothing. */
  readonly floating?: boolean;
  /** The writer asked for this view (a key, a click): keys are held back from
   * the page behind it while it downloads. A view that only decorates the page,
   * like the context meter, never takes keys. */
  readonly asked?: boolean;
}

export type LazyView<P extends object> = ((props: P & { readonly onDismiss?: () => void }) => ReactNode) & {
  /** Starts the download without showing anything. */
  readonly preload: () => void;
};

/** The address a failed dynamic import names in its message (Chrome, Firefox and Safari all do). */
function failedAddress(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return /https?:\/\/[^\s"')]+\.js/.exec(text)?.[0] ?? null;
}

/**
 * A view whose code downloads when it is first shown: `lazyView(() => import("./X.js"), "X")`.
 * A failed download shows a retry message. A browser keeps a failed import of
 * one address for the life of the page, so Retry asks for the same file under a
 * new query and renders the new attempt. While the view downloads, keys are
 * held back from the page behind it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = (props: any) => ReactNode;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type PropsOf<C extends AnyComponent> = Parameters<C>[0] extends infer A ? (A extends object ? A : {}) : {};

export function lazyView<M extends Record<K, AnyComponent>, K extends string>(
  load: () => Promise<M>,
  name: K,
  options: LazyViewOptions = {}
): LazyView<PropsOf<M[K]>> {
  type P = PropsOf<M[K]>;
  const floating = options.floating === true;
  const asked = options.asked === true;
  let failed: string | null = null;
  let retries = 0;
  const pick = async (): Promise<ComponentType<P>> => {
    try {
      return (await load())[name] as unknown as ComponentType<P>;
    } catch (error) {
      failed = failedAddress(error);
      throw error;
    }
  };
  const make = () => lazy(async () => {
    if (failed === null) return { default: await pick() };
    // Retry: the same file under a new address, so the browser fetches it again.
    const module = await import(/* @vite-ignore */ `${failed}?retry=${retries}`) as M;
    failed = null;
    return { default: module[name] as unknown as ComponentType<P> };
  });
  let Inner = make();
  const view = ({ onDismiss, ...props }: P & { readonly onDismiss?: () => void }): ReactNode => {
    const [attempt, setAttempt] = useState(0);
    const Current = Inner as ComponentType<P>;
    return (
      <ChunkBoundary
        key={attempt}
        onRetry={() => { retries += 1; Inner = make(); setAttempt((count) => count + 1); }}
        onDismiss={onDismiss}
        floating={floating}
      >
        <Suspense fallback={<>{asked && <HoldKeys onDismiss={onDismiss} />}{floating ? null : <p className="story-empty">{CHUNK_LOADING_TEXT}</p>}</>}>
          <Current {...(props as unknown as P)} />
        </Suspense>
      </ChunkBoundary>
    );
  };
  return Object.assign(view, { preload: () => { void load().catch(() => undefined); } });
}
