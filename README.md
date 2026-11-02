[Português](README.pt-BR.md) | English

# Almoxarifado

> **Archived (2026-11).** Not in production. The Worker was deleted on 2026-09-07. The code runs locally with demo data.

Construction site inventory control with QR codes. Every material has a label, every tool has an owner, and every movement stays in the history with who and when. Built for the person standing in the storeroom with the material in hand.

## What it was

An MVP built in August 2026 to present to a construction company (a prospect, not a client). It ran on Cloudflare Workers for about a month and the deal did not go ahead.

What it does:

- **Search that finds.** One box handles name, code, shelf, manufacturer barcode and tool asset number, without accents, with typos, or partial. Synonyms let "vergalhão", "ferro" and "CA-50" find the same item (SQLite FTS5).
- **QR labels.** A4 sheet printed on plain paper. The phone camera opens the system on the right item. QR generator written from scratch (`qr.js`), tested against a reference implementation.
- **Stock that does not lie.** Stock is the sum of the movement ledger, never a field someone edits. An issue larger than the balance is refused inside the transaction. Corrections are entries with a reason and a person.
- **Tools have an owner.** Who has the drill, since when, on which work front. Alert for tools out for more than seven days.
- **Requests with proof of delivery.** The foreman asks from the phone, the storekeeper delivers, and the receiver confirms with a PIN.
- **Inventory counts** turn each difference into a traceable adjustment, with an accuracy percentage.
- **Reports:** what to buy (by supplier), consumption by work front, ABC curve, expiry dates, idle stock. Exportable to spreadsheet.
- **Four access levels** decided on the server, not hidden in the UI. Multi-company and multi-site from the first table.

## Stack

Cloudflare Worker + D1 (SQLite) + R2, no framework and no build. The whole front end is `ui.html` imported as text, with `estilo.css` inlined: one request, no CDN, because the storeroom has a weak signal.

| file | what it is |
|---|---|
| `worker.js` | API and routing, by hand |
| `ui.html` | the whole interface, single file |
| `estilo.css` | theme tokens, light and dark |
| `schema.sql` | database structure |
| `qr.js` | own QR generator, no dependency |
| `ferramentas/gerar-seed.mjs` | builds the demo site data (`seed-demo.sql`) |
| `test/` | syntax, QR, API and visual tests |
| `docs/NOTAS-TECNICAS.md` | design decisions and traps (in Portuguese) |

## Run locally

```bash
npm install
npm run recarregar                         # schema + demo data in the local D1
npx wrangler dev --port 8788               # http://127.0.0.1:8788
```

Log in with company `demo` and user `diretoria`, `engenheiro`, `almoxarife` or `encarregado`, password `demo`. All demo data is fictitious.

## Tests

```bash
npm run verificar     # every <script> in ui.html parses
npm test              # QR generator against a reference implementation (jsqr)
npm run test:api      # 92 assertions through the API (needs wrangler dev on 8788)
npm run test:visual   # drives the UI with Playwright, checks touch targets; screenshots in test/telas/
npm run test:tudo     # all of the above, in order
```

Last run on 2026-11-01: syntax ok, QR ok, API 92 of 92, visual 42 of 42.

API and visual tests change the local demo database on purpose. Stop `wrangler dev` and run `npm run recarregar` afterwards.

## What I learned

- **Derived balance beats an editable field.** Making stock a sum over an append-only ledger removed a whole class of bugs and gave an audit trail for free. Tools are the exception: possession is a state machine, saved in the same transaction as its log.
- **Permissions belong on the server.** Hiding money columns in the UI is not access control.
- **A syntax test for inline scripts pays off.** One missing parenthesis made the browser drop a whole `<script>` block while the page still loaded; only a parse check caught it.
- **Measure the UI, do not eyeball it.** The visual test checks touch target sizes on a 390 px phone and a 1440 px desktop.
- **Search needs synonyms, not only fuzzy matching.** Field workers, engineers and invoices use different words for the same item.

## License

MIT. See [LICENSE](LICENSE).
