import type { ReactNode } from "react";

export function ErrorBanner({ message }: { message: string | null }): ReactNode {
  if (message === null) return null;
  return (
    <p role="alert" className="orion-error">
      {message}
    </p>
  );
}
