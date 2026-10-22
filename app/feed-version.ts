// The supplier feed reports its contract version as schema_version ("major.minor"). A newer
// minor only adds optional fields, so any minor of the supported major is read. Another major
// is a breaking change: imports and inventory sync stop instead of writing bad data.
export const SUPPORTED_MAJOR = 1;
// The newest version this app was written against; newer minors are fine.
export const KNOWN_VERSION = "1.2";
export const SUPPORTED_RANGE = `${SUPPORTED_MAJOR}.x (written for ${KNOWN_VERSION})`;

export const FEED_VERSION_RESULTS = ["compatible", "newer-minor", "unversioned", "unsupported", "invalid", "unavailable"] as const;
export type FeedVersionResult = (typeof FEED_VERSION_RESULTS)[number];
export const FEED_VERSION_TRIGGERS = ["preview", "import", "inventory", "settings"] as const;
export type FeedVersionTrigger = (typeof FEED_VERSION_TRIGGERS)[number];

export type FeedVersionVerdict = { version: string | null; result: FeedVersionResult; allowed: boolean; reason: string | null };

export function blocking(result: FeedVersionResult) {
  return result === "unsupported" || result === "invalid";
}

/** Decides whether the app can read a feed that reported this schema_version. */
export function feedVersionVerdict(value: unknown): FeedVersionVerdict {
  // Feeds from before versioning (production until the feed update is deployed) send nothing
  // and match 1.1, which this app reads.
  if (value === undefined || value === null) return { version: null, result: "unversioned", allowed: true, reason: null };
  const match = typeof value === "string" ? /^(\d{1,4})\.(\d{1,4})$/.exec(value) : null;
  if (!match) {
    return { version: null, result: "invalid", allowed: false,
      reason: "The supplier feed reported a schema version this app cannot read. Imports and inventory sync are paused until it is fixed." };
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const version = `${major}.${minor}`;
  if (major !== SUPPORTED_MAJOR) {
    return { version, result: "unsupported", allowed: false,
      reason: `The supplier feed uses schema ${version}, but this app supports ${SUPPORTED_MAJOR}.x. Imports and inventory sync are paused until the app is updated for the new feed.` };
  }
  const newer = minor > Number(KNOWN_VERSION.split(".")[1]);
  return { version, result: newer ? "newer-minor" : "compatible", allowed: true, reason: null };
}

export function feedVersionLabel(result: FeedVersionResult) {
  switch (result) {
    case "compatible": return "Compatible";
    case "newer-minor": return "Compatible (newer minor version; new fields are ignored)";
    case "unversioned": return "Compatible (the feed does not report a version yet, so it is read as 1.1)";
    case "unsupported": return "Not supported";
    case "invalid": return "Unreadable version";
    case "unavailable": return "Could not check (feed unreachable)";
  }
}

export function feedVersionTriggerLabel(trigger: FeedVersionTrigger) {
  switch (trigger) {
    case "preview": return "before an import preview";
    case "import": return "before an import";
    case "inventory": return "before inventory sync";
    case "settings": return "from Settings";
  }
}
