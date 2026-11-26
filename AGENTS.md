# AGENTS.md

How to work on Tally, for people and coding agents alike. [README.md](README.md) covers what the
app does.

## Layout

| Path | What lives there |
|---|---|
| `crates/sources` | The statement parsers: bytes in, normalized transactions out. No database. |
| `crates/core` (`tally-core`) | Every use case. The only crate that queries the database. |
| `crates/server` (`tally-server`, binary `tally`) | A thin gRPC / gRPC-web layer over `tally-core`; also serves `web/dist`. `src/auth` is passkey sign-in. |
| `crates/migration` | The schema, as SeaORM migrations. The source of truth for the database. |
| `crates/entity` | Generated from the migrations by `generate-entities`. Never edit by hand. |
| `proto/finance` | The API contract. `web/src/gen` is generated from it by `npm run generate`. |
| `web/` | The React app. `web/demo` holds the demo data and the screenshot script. |
| `docs/` | Design write-ups (HTML) and the README screenshots. |

## Dev shell

Enter it with `direnv allow` or `devenv shell`. It provides Rust, Node, buf, sea-orm-cli and
Postgres. `cargo` in the shell runs through the mbx build cache: keep calling plain `cargo`, and
don't set `RUSTC_WRAPPER` or sccache, which make mbx stop caching.

```sh
devenv up                    # local Postgres with the real database
cargo run -p tally-server    # API on 127.0.0.1:8080
cd web && npm run dev        # frontend on :5173, proxies the API
demo                         # made-up data on a throwaway database at 127.0.0.1:18080
DEMO_PASSKEY=1 demo          # the same with passkey sign-in on, at localhost:18080
```

## Checks

Run all of these before opening a PR:

```sh
cargo clippy --workspace --all-targets -- -D warnings
test-all                                           # Rust tests on a throwaway Postgres
buf lint proto
cd web && npm run typecheck && npm test && npm run build
```

## Conventions

**Backend**
- Money is `i64` cents, signed: negative means money left the account.
- `tally-core` uses jiff for dates. The generated entities use chrono, converted in `crates/core/src/time.rs`.
- New behaviour goes in `tally-core`, with an integration test in `crates/core/tests`. Server
  handlers only translate between proto and core types.
- Migrations are additive and forward-only. Add a new migration, never change one that has been
  merged, then run `generate-entities` and commit its output.
- The proto package is `finance`, with no version suffix. Evolve it compatibly: add fields, never
  renumber or reuse them. After a change, run `npm run generate` in `web/` and commit the output.
- Parsers accept exactly the real export format: no guessing at delimiters, headers or encodings.
- Passkey sign-in (`crates/server/src/auth`) checks signatures itself, ES256 only. Every check it
  makes has a test in `webauthn.rs` or `auth/tests.rs`; keep it that way. If you change sign-in,
  also run the browser check against `DEMO_PASSKEY=1 demo`:
  `cd web && CHROME=… node demo/passkey-check.mjs`. It uses a virtual passkey in Chromium.
- `nix/package.nix` pins a hash of the npm dependencies. When `web/package-lock.json` changes,
  update `npmDepsHash` (`prefetch-npm-deps web/package-lock.json`) in the same PR.

**Frontend**
- State worth keeping lives in the URL (TanStack Router search params), so a view survives a reload
  and can be linked.
- Server calls go through `src/api.ts`. Mutations go through `useAction`, which refreshes every
  query afterwards.
- Plain CSS with the tokens in `src/styles.css`, in a macOS style. Check light mode, dark mode and
  phone width (390 px) for anything you touch.
- The chart colours in `src/lib/categories.ts` are checked for colour-blind contrast in both
  themes. Don't add or reorder them casually.

## Privacy

The app holds real bank data, but the repo must never contain any.
- Never commit bank exports, database dumps, or screenshots of real data. Root-level CSV, TAB and TXT files are
  gitignored for this reason.
- Test fixtures (`crates/sources/tests/fixtures`) and screenshots use made-up data only. The demo
  (`web/demo`) is the source for screenshots.
- Before pushing, check the diff for IBANs, real names and amounts copied from real data.

## Pull requests

Every PR must include:

1. **What changed functionally.** In plain words, what someone using Tally can now do or see that
   they couldn't before. This is not a list of files. Call out anything that changes existing data
   or how totals are counted, such as migrations, rule behaviour or the overview's maths.
2. **Before and after screenshots** of every screen the change touches, taken from the demo data.
   - Take "before" on the base branch and "after" on your branch, with the same URL, window size
     and colour scheme. The demo data is seeded, so both show the same transactions.
     `demo` builds the current checkout. To run both side by side, use a worktree of the base
     branch with `DEMO_PORT=18081 demo`.
   - Use 1440×900 for desktop. Add dark mode and phone (390×844) shots when the change affects them.
   - Backend-only changes with nothing visible: say so, and show the behaviour another way, such as
     a test that covers it.
   - `gh` can't upload images. Push them to the `pr-assets` branch, an orphan branch used only for
     PR images, under `<your-branch>/`. Link them as
     `https://github.com/kalmjasper/tally/blob/pr-assets/<your-branch>/before.png?raw=true`.
3. **Passing checks** (see above).

If a change alters what the README screenshots show, regenerate them while `demo` runs and commit
the PNGs:

```sh
cd web && CHROME=$(nix build --no-link --print-out-paths nixpkgs#chromium)/bin/chromium node demo/screenshots.mjs
```

Commit messages: a short subject saying what changed for the user ("Link one incoming payment to
several expenses"), and a body explaining why when it isn't obvious.
