import { createContext, useContext, useEffect, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useBeforeUnload, useLocation } from "react-router";
import { restoreDraft, signature, workspaceHref } from "./workspace-policy";
import type { Configuration, Draft } from "./workspace-policy";
import { defaultListingPolicy } from "./listing-policy";
import { PendingLink } from "./network-state";

// release is the full commit SHA the lab is running, or null outside a lab release (development).
type Workspace = { draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; storageAvailable: boolean; release: string | null };
const Context = createContext<Workspace | null>(null);

export function WorkspaceProvider({ shop, saved, release, children }: {
  shop: string; saved: Configuration; release?: string | null; children: ReactNode;
}) {
  const [draft, setDraft] = useState<Draft>(() => ({
    ...saved, baseline: signature(saved), products: {}, browse: "", active: false, publish: false, listingPolicy: defaultListingPolicy(),
    selectionSearch: "", selectionPage: 1,
  }));
  const [hydrated, setHydrated] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const key = `ultralove-workspace-v1:${shop}`;
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(key);
      const restored = stored && restoreDraft(JSON.parse(stored), saved);
      // Restore after hydration so server HTML never depends on browser-only storage.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (restored) setDraft((current) => ({ ...restored, products: { ...current.products, ...restored.products } }));
    } catch { setStorageAvailable(false); }
    setHydrated(true);
    // The server baseline is reconciled by the catalog after successful saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!hydrated) return;
    try {
      const selectedProducts = Object.fromEntries(draft.selected.filter((id) => draft.products[id]).map((id) => [id, draft.products[id]]));
      sessionStorage.setItem(key, JSON.stringify({ ...draft, products: selectedProducts }));
    // Storage availability is an external runtime capability, not derived UI state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    } catch { setStorageAvailable(false); }
  }, [draft, hydrated, key]);
  useBeforeUnload((event) => {
    if (!storageAvailable && signature(draft) !== draft.baseline) { event.preventDefault(); event.returnValue = ""; }
  });
  return <Context.Provider value={{ draft, setDraft, storageAvailable, release: release ?? null }}>{children}</Context.Provider>;
}

export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("Workspace provider is required.");
  return value;
}

export function WorkspaceNav({ current }: { current: string }) {
  const { draft, release } = useWorkspace();
  const { search } = useLocation();
  return <nav className="workspace-nav" aria-label="UltraLove workspace">
    {[
      ["catalog", "Catalog"], ["selection", `Selection & pricing (${draft.selected.length})`],
      ["imports", "Imports"], ["inventory", "Inventory"], ["settings", "Settings"],
    ].map(([view, label]) => <PendingLink key={view} aria-current={current === view || (current === "review" && view === "selection") ? "page" : undefined}
      to={workspaceHref(search, view, draft.browse)} pendingLabel={`Loading ${label}`}>{label}</PendingLink>)}
    <span className="workspace-lab">Integration lab · CAD · <span title={release ? `Running release ${release}` : undefined}>
      {release ? release.slice(0, 7) : "development"}</span></span>
  </nav>;
}
