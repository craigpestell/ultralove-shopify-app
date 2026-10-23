import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { assertShopDomain } from "../shop-policy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    assertShopDomain(shop);
    console.log(`Received ${topic} webhook for ${shop}`);

    const current: unknown = payload.current;
    if (!Array.isArray(current) || !current.every((scope) => typeof scope === "string")) {
        console.error("Rejected an invalid Shopify scope-update payload.");
        return new Response("Invalid scope-update payload.", { status: 400 });
    }
    if (session) {
        await db.session.update({   
            where: {
                id: session.id
            },
            data: {
                scope: current.toString(),
            },
        });
    }
    return new Response();
};
