# Third-party notices

Fliptimize (Android app currently named FlipScout) is proprietary software. It includes the open-source component below.
Its licence allows commercial use, modification and proprietary distribution, provided the copyright notice and licence
text are kept with every copy. The app shows the full text under **Settings → Open-source licences**.

## Papa Parse 5.7.0

- What it does in the app: reads and writes spreadsheet (CSV) files for My Stock and expenses (import and export).
- Source: https://github.com/mholt/PapaParse, release tag 5.7.0 (24 Aug 2026), file `papaparse.min.js`.
- How it is included: bundled unchanged inside `index.html` as `<script id="papaparse">`, with the licence text in a
  comment directly above it. SHA-256 of the bundled file: `4d5d2d6e3282b66aafaa5e6de8ca3ae06f8d3440111ae99c6a30f6c00cfac33e`
  (checked by `tests/toolkit.test.mjs`).
- Dependencies: none. No network use: the app only calls the in-memory parse and unparse functions (not the remote-download
  or background-worker modes).
- Security: the only published advisory (CVE-2020-36649, slow parsing of crafted input) was fixed in 5.2.0. The app also
  limits imports to 2 MB and 5,000 rows.
- Licence: MIT (text below). Obligations: keep the copyright notice and licence text with the app.

```
The MIT License (MIT)

Copyright (c) 2015 Matthew Holt

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
