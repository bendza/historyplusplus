# Search quality eval

Measures how well history++ finds pages in a real history database. It runs the production
engine (`HistoryDb` from `src/engine/db.ts`) in Node on sqlite-wasm, embeds queries with the
`Xenova/multilingual-e5-small` model from `models/` (or the older `public/models/`; run
`npm run fetch-model` if neither has it) (q8, `query: ` prefix, mean pooling, normalized, same as
`src/embed/indexer.ts` + `embed.worker.ts`) and scores the results. Fully offline.

## Run

```sh
npm run eval                          # finds Edge's/Chrome's OPFS database automatically
npm run eval -- --db path/to.sqlite   # or a plain SQLite file (e.g. an exported database)
npm run eval -- --now 2026-10-14T16:00               # pin "today" for date phrases
npm run eval -- --set meaningZ=2.75 --set chunkPenalty=0.5   # try other search knobs
npm run eval -- --queries my-queries.json            # another labelled set
```

`--now` defaults to the newest visit in the database, so "yesterday" / "last week" in labelled
queries keep meaning what they meant when the snapshot was taken. `--set` overrides one field of
`HistoryDb.tuning` (`SearchTuning` in `src/engine/db.ts`) for the run; the tuning in effect is
printed at the top. Change the defaults in `db.ts` only when the eval shows hybrid hit@5 and MRR
do not drop.

Auto-locate scans `~/Library/Application Support/{Microsoft Edge,Google/Chrome}/Default/File System`
for the largest file holding a SQLite header at offset 4096 (the OPFS SAH-pool layout), copies it to
`$TMPDIR/history-pp-eval/`, strips the 4 KiB header and deserializes it into an in-memory database.
The browser profile is only read, never written. If the extension is writing while you copy, pass
`--db` with an exported file instead.

Output: a console summary and `scripts/eval/report.md` (adds the hybrid top 3 for every query).
The report contains titles from your history and is gitignored, as are `*.sqlite` copies. Never commit them.

## Views scored per query

| view | what it is |
|---|---|
| keyword | `search({mode: 'keyword'})`: FTS5 + bm25 only |
| meaning | the engine's own meaning candidates (`meaningCandidates`, after the z-score floors, max 30) |
| vector* | rank among *all* pages by best-chunk similarity (`VectorIndex.search` with no floor): what the floors and pool cap throw away |
| hybrid | `search()` with a query vector: the real default (RRF of keyword + meaning) |

Metrics, over the top 20: **hit@k** = share of queries with an expected page in the top k;
**MRR** = mean of 1/rank of the first expected page (0 if not in the top 20).

`bestZ` (per query) is the best page's corpus-centered similarity in standard deviations above
that query's mean: the scale the meaning floors work on. Date phrases the engine understood are
listed with their labels.

Negative queries (topic absent from history) pass when no meaning-retrieved hit (`meaning` or
`both`) is in the hybrid top 3.

Sanity suites (no labels, seeded so runs are repeatable):
- **(a) text phrase**: for pages with captured text, a 6-10 word run from the middle of the text,
  typed as-is; expected = any page whose text contains that run. Should be ~100% at #1 for keyword.
- **(b) shuffled title words**: 3-5 content words from a page title (stopwords dropped, shuffled);
  expected = any page with that exact title. Hybrid and meaning ranks show how robust title recall is.

## Adding queries

Edit `queries.json`. Each item:

```json
{ "id": "ph-island", "kind": "paraphrase-hard", "query": "the guy selling an island in africa",
  "expect": ["x.com/TimDraper/status/2093402615044542975"],
  "visitedBetween": ["2026-10-01", "2026-10-15"] }
```

- `expect`: case-insensitive substrings matched against each hit's URL **or** title; any one
  matching makes the hit relevant. History has many near-duplicate URLs (tracking params,
  search-result variants), so check the database for every acceptable variant before labelling:
  `sqlite3 -readonly <copy> "select id,url,title from pages where title like '%...%'"`.
- `visitedBetween` (optional): local dates `[from, to)`; the page must also have a visit in range.
  Used by `temporal` queries, whose text uses plain date phrases ("last week", "u avgustu") that
  the engine turns into a filter. Ranges are absolute, so they are pinned to the snapshot they
  were written against (see `--now`); update them when you refresh the database.
- `expect: []` marks a negative query.
- `kind` is free-form; per-kind numbers are printed for every kind present.
