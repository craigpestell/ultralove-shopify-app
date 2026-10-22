// Pure matching rules for in-flight requests, so every button, link and status line agrees on what is pending.

export type PendingRequest = {
  state: "idle" | "loading" | "submitting";
  location?: { pathname: string; search: string };
  formMethod?: string;
  formData?: FormData;
};

/** Describes one request: a form submission (by intent, method or extra fields) or a page load (by destination). */
export type RequestMatch = {
  intent?: string | string[];
  method?: "GET" | "POST";
  fields?: Record<string, string>;
  to?: string;
};

const IGNORED_PARAMS = new Set(["index"]);

function params(search: string) {
  return [...new URLSearchParams(search)].filter(([key]) => !IGNORED_PARAMS.has(key))
    .map(([key, value]) => `${key}=${value}`).sort().join("&");
}

/** True when the navigation is heading to `to`, compared by path and query regardless of parameter order. */
export function sameDestination(to: string, location: { pathname: string; search: string }) {
  const target = new URL(to, "https://app.invalid");
  return target.pathname === location.pathname && params(target.search) === params(location.search);
}

export function requestPending(request: PendingRequest, match: RequestMatch = {}) {
  if (request.state === "idle") return false;
  if (match.to !== undefined) return !request.formMethod && !!request.location && sameDestination(match.to, request.location);
  if (match.method && request.formMethod?.toUpperCase() !== match.method) return false;
  if (match.intent !== undefined) {
    const intents = Array.isArray(match.intent) ? match.intent : [match.intent];
    const intent = request.formData?.get("intent");
    if (typeof intent !== "string" || !intents.includes(intent)) return false;
  }
  for (const [name, value] of Object.entries(match.fields ?? {})) {
    if (request.formData?.get(name) !== value) return false;
  }
  return true;
}
