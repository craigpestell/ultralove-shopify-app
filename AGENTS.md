# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## Network state in the UI

Use `app/network-state.tsx` for anything that makes a network call, instead of reading `useNavigation()` directly:

- `useNetworkState()` gives `busy` (disable inputs during any request) and `pending(match)` (show `loading` on the control that started it). Match a submission by `intent`, `method` or `fields`, or a page load by `to`.
- `PendingLink` replaces `Link` for links that load data. It shows a spinner and ignores repeat clicks while its page loads.
- `RequestFeedback` shows a pending message, an error banner or a success banner for one request.
- `AdminLoadingBar` (mounted in `app/routes/app.tsx`) drives the Shopify admin loading bar for every navigation and fetcher.
