import { useCallback, useEffect } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Link, useFetchers, useNavigation } from "react-router";
import { requestPending } from "./network-policy";
import type { RequestMatch } from "./network-policy";

/**
 * One source of truth for network state. `busy` locks inputs during any request;
 * `pending(match)` marks the specific control that started it.
 */
export function useNetworkState() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const pending = useCallback((match?: RequestMatch) => requestPending(navigation, match), [navigation]);
  return { busy, pending };
}

// App Bridge's global exists only inside the Shopify admin, so tests and direct visits skip it.
function adminLoading(loading: boolean) {
  const bridge = (globalThis as { shopify?: { loading?: (isLoading?: boolean) => void } }).shopify;
  if (typeof bridge?.loading === "function") bridge.loading(loading);
}

/** Mirrors page loads, submissions and fetcher loads in the Shopify admin's top loading bar. */
export function AdminLoadingBar() {
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const loading = navigation.state !== "idle" || fetchers.some((fetcher) => fetcher.state !== "idle");
  useEffect(() => { adminLoading(loading); }, [loading]);
  useEffect(() => () => adminLoading(false), []);
  return null;
}

/** A link that shows a spinner and ignores repeat clicks while its destination loads. */
export function PendingLink({ to, className, pendingLabel = "Loading", children, ...rest }:
  { to: string; className?: string; pendingLabel?: string; children: ReactNode; "aria-current"?: "page" }) {
  const { pending } = useNetworkState();
  const loading = pending({ to });
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => { if (loading) event.preventDefault(); };
  return <Link to={to} className={["pending-link", className].filter(Boolean).join(" ")} onClick={onClick}
    aria-busy={loading || undefined} aria-disabled={loading || undefined} data-pending={loading || undefined} {...rest}>
    {loading && <s-spinner size="base" accessibilityLabel={pendingLabel} />}
    {children}
  </Link>;
}

/**
 * Pending, success and error feedback for one request, announced to screen readers.
 * Pending shows only while `pending` is true; success and error come from the completed response.
 */
export function RequestFeedback({ pending = false, pendingMessage, success, successHeading, error, errorHeading = "Action could not be completed", children }: {
  pending?: boolean; pendingMessage?: ReactNode; success?: ReactNode; successHeading?: string;
  error?: ReactNode; errorHeading?: string; children?: ReactNode;
}) {
  if (pending) return pendingMessage ? <p role="status" className="request-pending">
    <s-spinner size="base" accessibilityLabel="In progress" /><span>{pendingMessage}</span></p> : null;
  if (error) return <div role="alert"><s-banner heading={errorHeading} tone="critical">{error}{children && <> {children}</>}</s-banner></div>;
  if (success) return <div role="status" className="request-feedback"><s-banner heading={successHeading} tone="success">{success}</s-banner></div>;
  return null;
}
