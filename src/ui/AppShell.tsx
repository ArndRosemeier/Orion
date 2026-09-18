import type { ReactNode, RefObject } from "react";
import { ErrorBanner } from "./ErrorBanner";

export type AppShellProps = {
  title: string;
  tagline: string;
  centreLabel: string;
  status: string;
  error: string | null;
  viewportRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
};

/**
 * The dark presentation frame: a top bar, an edge-to-edge viewport and a status
 * bar. The viewport's first child is the caller's visible display canvas; this
 * shell never creates one.
 */
export function AppShell({
  title,
  tagline,
  centreLabel,
  status,
  error,
  viewportRef,
  children,
}: AppShellProps): ReactNode {
  return (
    <div className="orion-shell">
      <header className="orion-topbar">
        <h1>{title}</h1>
        <p className="orion-tagline">{tagline}</p>
        <p className="orion-readout">{centreLabel}</p>
      </header>
      <div className="orion-viewport" ref={viewportRef}>
        {children}
      </div>
      <footer className="orion-statusbar">
        <p className="orion-status">{status}</p>
      </footer>
      <ErrorBanner message={error} />
    </div>
  );
}
