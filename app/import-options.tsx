import { useState } from "react";

export default function ImportOptions({ active = false, publish = false, disabled = false, onChange }: {
  active?: boolean; publish?: boolean; disabled?: boolean; onChange?: (active: boolean, publish: boolean) => void;
}) {
  const [makeActive, setMakeActive] = useState(active);
  const [publishOnlineStore, setPublishOnlineStore] = useState(publish);

  const currentActive = onChange ? active : makeActive;
  const currentPublish = onChange ? publish : publishOnlineStore;
  return <fieldset className="catalog-import-options">
    <legend>New product visibility</legend>
    <p>{currentActive ? currentPublish ? "Active and published to Online Store" : "Active, not published" : "Unpublished drafts (recommended)"}</p>
    <details><summary>Change visibility for new products</summary>
    <label><span><input type="checkbox" role="switch" name={onChange ? undefined : "active"} value="yes" checked={currentActive} disabled={disabled}
      onChange={(event) => {
        onChange?.(event.currentTarget.checked, event.currentTarget.checked && currentPublish);
        setMakeActive(event.currentTarget.checked);
        if (!event.currentTarget.checked) setPublishOnlineStore(false);
      }} /> Set new products to Active</span></label>
    <label><span><input type="checkbox" role="switch" name={onChange ? undefined : "publish"} value="yes" checked={currentPublish}
      disabled={disabled || !currentActive} aria-describedby="publish-import-help"
      onChange={(event) => { setPublishOnlineStore(event.currentTarget.checked); onChange?.(currentActive, event.currentTarget.checked); }} /> Publish new products to Online Store</span></label>
    <p id="publish-import-help">Publishing requires Active status and makes new products available on the Online Store.
      With both switches off, new products remain drafts. Existing products are never activated or published by this job.</p></details>
  </fieldset>;
}
