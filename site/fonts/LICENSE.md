# Fonts shipped with the landing page

Self-hosted so that visiting the TokenFlow site makes no request to a third
party. All three families are published under the SIL Open Font License 1.1,
which permits redistribution and embedding; the files are the Google Fonts
woff2 builds, copied unchanged.

| Family | Weights | Role | License |
|---|---|---|---|
| Space Grotesk | 500, 600, 700 | display | OFL-1.1 - https://github.com/floriankarsten/space-grotesk |
| IBM Plex Sans | 400, 500, 600 | body | OFL-1.1 - https://github.com/IBM/plex |
| IBM Plex Mono | 400, 500, 600 | figures, code | OFL-1.1 - https://github.com/IBM/plex |

The `@font-face` rules that load them are generated into `site/styles.css` from
`design/tokens.yaml` (`landing.fonts`). Add a weight there, copy the file here,
run `npm run design`.
