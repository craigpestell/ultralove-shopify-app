import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";
import { assertLabRequest, LAB_SHOP } from "../../lab-policy.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await assertLabRequest(request);
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login), shop: LAB_SHOP };
};

export default function App() {
  const { showForm, shop } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>UltraLove Catalog</h1>
        <p className={styles.text}>
          Import UltraLove products, manage your own stock, or choose supplier-backed dropshipping inventory. Test store only.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" defaultValue={shop} readOnly />
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <p>Imports require review and confirmation. Order forwarding is not enabled.</p>
      </div>
    </div>
  );
}
