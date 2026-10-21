# Chrome Web Store: "Privacy practices" tab answers

## Single purpose
history++ keeps the user's browsing history permanently on their device and lets them search and browse it.

## Permission justifications
| Permission | Justification |
|---|---|
| `history` | Imports the browser's existing history on install and catches up on visits missed while the extension was off, so the user's history is complete. |
| `<all_urls>` (host permission) | A content script reads the readable text of pages the user visits (after a few seconds; never in private windows, on a built-in list of banking, email, sign-in and payment sites, on sites the user lists, or on pages with password or card fields), so the user can search inside pages they've read. Text is stored only on the device. |
| `tabs` | Records which page each visit belongs to, opens search results, and opens or focuses the history++ page. |
| `webNavigation` | Detects in-page navigation on single-page sites, which have no full page load, so those visits are recorded too. |
| `storage`, `unlimitedStorage` | Stores settings, and keeps the user's history database on the device without the default quota, because history grows over years. |
| `offscreen` | Runs the local SQLite database and the on-device search model in an offscreen document, because service workers can't host long-running workers. |
| `alarms` | Schedules the daily backup and the periodic catch-up of missed visits. |
| `downloads` | Writes the daily backup file of the user's own data to their Downloads folder. |
| `downloads.ui` | Hides the download bubble for the automatic daily backup, so it doesn't interrupt the user every day. |
| `favicon` | Shows site icons next to results, using the browser's own icon cache. No network requests are made. |

## Remote code
**No, I am not using remote code.** All JavaScript and WebAssembly is in the package. The only download is the multilingual-e5-small model *weights* (data files, not executable code), from huggingface.co. They're pinned to a fixed commit, size- and SHA-256-verified, and fetched only when the user turns on search by meaning.

## Data usage: what the extension handles
Tick these, and add the note below:
- [x] **Web history**
- [x] **Website content** (text of pages the user visits)

Leave the others unticked (personally identifiable info, health, financial, authentication, personal communications, location, user activity such as clicks and keystrokes).

**Note to add if there's a free-text field:** all of this data is processed and stored only on the user's device and is never transmitted to the developer or third parties.

> **Check when submitting:** Google's definitions of "collect" may or may not cover data that never leaves the device. Declaring Web history and Website content is the safe, transparent choice for a history extension. Reviewers reject under-declaring, not over-declaring.

## Certifications (tick all three)
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL
https://gist.github.com/bendza/7bf6bc33bdaf3294d92db3e99edb8d49
