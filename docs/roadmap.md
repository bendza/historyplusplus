# history++ roadmap

Constraints: everything stays on the device, no LLM for now, verified end to end in real browsers.

## Before the HN launch
- [ ] **Bring back deleted history** from Google's "My Activity" / Takeout export (check first what it actually contains).
- [ ] **Address-bar search**: `h` + space searches history by meaning.
- [ ] **Open at the passage**: clicking a result scrolls to the matching text (text fragments).

## Finding things
- [ ] ★ **Rescue dead links**: when a page is gone (404, deleted, paywalled), show the saved text plus a Wayback Machine link.
- [ ] ★ **YouTube transcripts**: index what a video said.
- [ ] **PDFs** opened in the browser get indexed.
- [ ] **Past searches**: every Google search, plus what was opened from it.
- [ ] **Pages actually read rank first** (time on page).
- [ ] **Type filters**: docs, videos, GitHub, job posts, shopping.

## Looking back
- [ ] ★ **On this day**: a month ago and a year ago, on the home screen.
- [ ] **Unfinished reading**: articles opened and left after seconds.
- [ ] **Research threads**: pages grouped by topic automatically.
- [ ] **Weekly recap**: plain stats, no AI writing.
- [ ] **Reopen a session**, **"you've been here before"** badge.

## Control
- [ ] **Forget rules** (e.g. delete shopping sites after 30 days).
- [ ] **Pause with a timer**.
- [ ] **Storage controls**: size per year estimate; keep text for N years, titles forever.
- [ ] **Export** to Markdown / Obsidian.
- [ ] **Sync between computers** via a backup folder (Dropbox, iCloud).
- [ ] **Send to bookmark++**.

## Later
- Command-line tool or MCP server reading the backup file.
- Local LLM answers (Ollama), only if wanted.
- Phone browsing: test whether synced visits reach the extension; otherwise say plainly it's desktop only.

## Known limits
- Topics not in your history can still show a few "related" results.
- Export JSON may fail on very large databases (message size).
- Firefox indexing is slower (single-threaded).
- Imported history has titles and addresses only.
