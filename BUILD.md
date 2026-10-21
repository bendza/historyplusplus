# Building history++ from source

Requirements: Node.js 22 and npm 10 (macOS, Linux or Windows).

```
npm ci                    # installs dependencies; postinstall applies patches/ and runs `wxt prepare`
npm run build:firefox     # Firefox build -> .output/firefox-mv2/
npm run build             # Chrome/Edge/Brave build -> .output/chrome-mv3/
```

`npm test` runs the unit tests.

The repository path containing `++` needs the WXT patch in `patches/`, which `npm ci` applies automatically.

## Notes for reviewers
- **No remote code.** All JavaScript and WebAssembly ships in the package. That includes SQLite and the onnxruntime wasm under `ort/`.
- **One network request: the model download.**
  - The only request the extension makes is a one-time download of the multilingual-e5-small model *weights*. These are data files, not code.
  - They come from huggingface.co, pinned to commit `761b726dd34fb83930e26aab4e9ac3899aa1fa78`. Each file's size and SHA-256 are verified before use.
  - The download starts only when the user clicks **Download**.
  - No user data is ever sent anywhere. The CSP `connect-src` allows only the extension itself and those model hosts.
- **Third-party URLs in `content.js` are unused.** The bundled text extractor (Defuddle) contains optional site extractors that reference api.fxtwitter.com, publish.twitter.com, youtube.com and api.bilibili.com. history++ turns them off (`useAsync: false` in `src/capture/extract.ts`), so they are never called.
- **Storage.** Browsing history, page text and the search index are stored in a local SQLite database, in the extension's private browser storage (OPFS).
