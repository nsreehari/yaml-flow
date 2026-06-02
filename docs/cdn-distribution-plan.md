# yaml-flow CDN distribution plan

## Goal

Make the IIFE bundles under `yaml-flow/browser/` consumable as long-lived,
versioned URLs so host apps (e.g. `demo-boards-frontend`) stop vendoring them
into their own repos. Each bundle ships with an integrity hash so consumers
can pin against tampering.

## Current state

`npm run build:browser` already produces a complete distribution under
`yaml-flow/browser/`:

```
browser/
  live-cards.js                 + .map
  live-cards.schema.json
  compute-jsonata.js            + .map
  board-livecards-client.js     + .map
  server-runtime-controlface.js + .map
  board-livegraph-engine.js     + .map
  card-compute.js
  asset-integrity.json
  adapters/
    firestore-storage.js        + .map
    localstorage-storage.js     + .map
    firebase-storage.js         + .map
```

`scripts/generate-browser-integrity.mjs` regenerates `asset-integrity.json`
on every build with `sha384-...` hashes for the consumer-facing files.

## Recommended layout

Publish under a versioned prefix so old consumers don't break when we ship a
new version:

```
https://cdn.<host>/yaml-flow/<version>/live-cards.js
https://cdn.<host>/yaml-flow/<version>/server-runtime-controlface.js
https://cdn.<host>/yaml-flow/<version>/adapters/firestore-storage.js
https://cdn.<host>/yaml-flow/<version>/adapters/localstorage-storage.js
https://cdn.<host>/yaml-flow/<version>/adapters/firebase-storage.js
https://cdn.<host>/yaml-flow/<version>/asset-integrity.json
```

`<version>` is the `package.json#version` of the publish, not a Git SHA, so
consumers can opt in to a release cycle. A `latest/` mirror is intentionally
NOT exposed — pinning is the only supported usage pattern.

## Two viable hosts

1. **Firebase Hosting under the existing `finbook-492706` project.**
   - Reuse the same CDN edge the demo already speaks to.
   - `firebase.json` rewrite: serve `/yaml-flow/<version>/**` from
     `yaml-flow/dist-cdn/<version>/**` with `Cache-Control: public,
     max-age=31536000, immutable`.
   - Cheapest path; ships with existing auth/identity story.

2. **GitHub Pages from `gh-pages` branch of yaml-flow.**
   - Zero infra cost. Slightly slower edge.
   - Same versioned prefix layout.

Pick (1) for production; (2) is fine for dev/PR previews.

## Publish pipeline

A new `npm run release:cdn` script (to be added) should:

1. Run `npm run build:lib && npm run build:browser`.
2. Verify `browser/asset-integrity.json` matches a fresh recomputation.
3. Read `package.json#version` and stage `browser/**` under
   `dist-cdn/<version>/**`.
4. Run `firebase deploy --only hosting:<target>` (or `gh-pages` push), and
   write a release tag matching the version.

The CI workflow gates this on a green `npm run build:lib && vitest run`.

## Consumer migration: demo-boards-frontend

[demo-boards-frontend/vendored/yaml-flow/](../../demo-boards-frontend/vendored/yaml-flow/)
currently vendors the bundle. After CDN go-live we should:

1. Replace each `import '../../vendored/yaml-flow/browser/<file>.js'` in
   `src/lib/*.js` with a CDN `<script src="..." integrity="sha384-..." crossorigin="anonymous">`
   tag injected at app boot, exactly like
   [firebase-app.js](../../demo-boards-frontend/src/lib/firebase-app.js)
   loads the Firebase compat SDK from `gstatic`.
2. Source the `integrity` value from a small build-time JSON manifest
   downloaded once per release (`asset-integrity.json`), so refreshes don't
   require a frontend code change.
3. Delete `demo-boards-frontend/vendored/yaml-flow/`.

## Open decisions

- Which CDN host: Firebase vs. GitHub Pages vs. jsdelivr+npm publish.
- Whether to npm-publish the browser dir as a separate package
  (`@yaml-flow/browser`) so consumers can `<script src="https://cdn.jsdelivr.net/npm/@yaml-flow/browser@<v>/dist/...">`
  without us standing up infrastructure.
- Versioning policy: SemVer with adapters as part of the same version, or
  separate `@yaml-flow/firestore-storage` style packages.

Recommend deciding once the second consumer (beyond demo-boards-frontend)
arrives — until then, vendoring + this plan is the right tradeoff.
