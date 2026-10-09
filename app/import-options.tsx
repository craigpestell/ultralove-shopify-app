import { useState } from "react";

export default function ImportOptions({ active = false, publish = false }: { active?: boolean; publish?: boolean }) {
  const [makeActive, setMakeActive] = useState(active);
  const [publishOnlineStore, setPublishOnlineStore] = useState(publish);

  return <fieldset className="catalog-import-options">
    <legend>New product visibility</legend>
    <label><span><input type="checkbox" role="switch" name="active" value="yes" checked={makeActive}
      onChange={(event) => {
        setMakeActive(event.currentTarget.checked);
        if (!event.currentTarget.checked) setPublishOnlineStore(false);
      }} /> Set new products to Active</span></label>
    <label><span><input type="checkbox" role="switch" name="publish" value="yes" checked={publishOnlineStore}
      disabled={!makeActive} aria-describedby="publish-import-help"
      onChange={(event) => setPublishOnlineStore(event.currentTarget.checked)} /> Publish new products to Online Store</span></label>
    <p id="publish-import-help">Publishing requires Active status and makes new products available on the Online Store.
      With both switches off, new products remain drafts. Existing products are never activated or published by this job.</p>
  </fieldset>;
}
