# Contributing to history++

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with:
- your browser and its version, and the history++ version (shown on `chrome://extensions`);
- what you did, what you expected, and what happened;
- anything from the extension's console (`chrome://extensions` → history++ → "service worker" / "Inspect views").

Please don't paste real browsing history, page text or backups into issues.

## Security and privacy problems

If you find a way for history++ to leak data or record something it shouldn't, please email bendza@mail.com instead of opening a public issue.

## Working on the code

```sh
npm ci           # installs, applies patches/ and runs `wxt prepare`
npm run dev      # Chromium with the extension loaded and hot reload
npm test         # unit tests (vitest)
npm run compile  # typecheck
```

- `entrypoints/`: background, content script, popup, app and offscreen pages (WXT).
- `src/capture/`: recording visits and page text; privacy checks happen here and in `src/shared/privacy.ts`.
- `src/engine/`: the SQLite database, keyword and meaning search.
- `src/embed/`: the on-device embedding model and indexer.
- `src/ui/`: the app and popup.

Before opening a pull request, run `npm test` and `npm run compile`, and try the change in a real browser. Changes to search ranking should not make `npm run eval` (see `scripts/eval/README.md`) worse.

The project's rules: nothing leaves the device apart from the one-time model download, no remote code, no analytics.

By contributing you agree that your contribution is licensed under the MIT License, like the rest of the project.
