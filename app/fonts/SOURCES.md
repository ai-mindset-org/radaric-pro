# Font sources

The fonts the per-role font picker ships (RAD-363). Each family folder holds its
licence (`OFL.txt`, copied from upstream) next to the files the app serves.
`lib/typography/font-metrics.json` pins every served file's sha256, so a file
replaced without re-running `scripts/typography/measure-fonts.py` fails the
typography tests.

The SF options (SF Pro, SF Pro Rounded, SF Mono) are Apple system fonts. They
are licensed by Apple, cannot be embedded, and are never shipped here — the CSS
only asks for the font already installed on an Apple device.

| Family | Version | Upstream | Licence | Served as |
|---|---|---|---|---|
| Inter | 4.001 (release `v4.1`) | https://github.com/rsms/inter/releases/tag/v4.1 — `Inter-4.1.zip` → `InterVariable.ttf` | OFL-1.1, no Reserved Font Name | subset, three woff2 files |
| Martian Mono | 1.100 (release `v1.1.0`) | https://github.com/evilmartians/mono/releases/tag/v1.1.0 — `martian-mono-1.1.0-variable.zip` | OFL-1.1, no Reserved Font Name | upstream woff2, unmodified |
| Martian Grotesk | 1.000 (release `v1.0.0`) | https://github.com/evilmartians/grotesk/releases/tag/v1.0.0 — `martian-grotesk-1.0.0-variable.zip` | OFL-1.1, no Reserved Font Name (see note) | upstream woff2, unmodified |
| PT Root UI | 1.002 | https://github.com/paratype-fonts/free/tree/master/PT-Root-UI-VF (commit `5e9c20a`) | OFL-1.1, Reserved Font Name "PT Root UI VF" | upstream woff2, unmodified |
| Golos Text | 2.004 | https://github.com/google/fonts/blob/main/ofl/golostext/GolosText%5Bwght%5D.ttf (`wght` 400–900) | OFL-1.1, no Reserved Font Name | converted to woff2, full cmap (no subset) |
| IBM Plex Sans | 3.000 (release `@ibm/plex-sans-variable@0.2.0`) | https://github.com/IBM/plex/releases/tag/%40ibm%2Fplex-sans-variable%400.2.0 — `plex-sans-variable.zip` → `fonts/split/woff2/IBM Plex Sans Var-Roman-*.woff2` | OFL-1.1, Reserved Font Name "Plex" | upstream woff2, unmodified (six Roman splits) |
| JetBrains Mono | 2.305 | https://github.com/JetBrains/JetBrainsMono — `fonts/webfonts/JetBrainsMono[wght].woff2` at commit `19371302` (`wght` 100–800; the VF webfont is not in the `v2.304` release archive) | OFL-1.1, no Reserved Font Name | upstream woff2, unmodified |
| IBM Plex Mono | 2.005 (release `@ibm/plex-mono@2.5.0`) | https://github.com/IBM/plex/releases/tag/%40ibm%2Fplex-mono%402.5.0 — `ibm-plex-mono.zip` → `fonts/complete/woff2/IBMPlexMono-{Regular,Medium,SemiBold,Bold}.woff2` | OFL-1.1, Reserved Font Name "Plex" | upstream woff2, unmodified (four static weights) |

## Files

| File | sha256 | Size (bytes) | Origin |
|---|---|---|---|
| `inter/InterVariable-latin.woff2` | `391a08c6c2ea60f697678a67f8c25ce89df44237e27e0efc154dd2efa1419d43` | 98400 | subset of `InterVariable.ttf` |
| `inter/InterVariable-cyrillic.woff2` | `751a319d9f4d46b7d8fa89896234d61bc47d825cf34782d475335ffc5ed54068` | 52424 | subset of `InterVariable.ttf` |
| `inter/InterVariable-ext.woff2` | `e05120de46ace766fc9afbc032b54b2ed39ba51af1c7bc2e3ef7968026f441ab` | 172688 | subset of `InterVariable.ttf` |
| `martian-mono/MartianMonoVF.woff2` | `7cdf8e985a4872246d8c2a19333bcc5e8cbcf512746128823f35c1c43aac238a` | 83044 | as released |
| `martian-grotesk/MartianGrotesk-VFVF.woff2` | `d2223e87b0f1020b98a1c376282d5d2da61cc8347f59052a934f11460d952b95` | 116364 | as released |
| `pt-root-ui/PT-Root-UI-VF.woff2` | `fa444d1a14ae9486628fd17214c19c2b0f5d82ca3efc646c9ca856eb35c41e47` | 78520 | as released |
| `golos-text/GolosText-VF.woff2` | `670ac5ea4bf1f8b20b436241a4c330302e11fc2f1f1f886669e8635d002a8c07` | 76716 | converted from `GolosText[wght].ttf` |
| `ibm-plex-sans/IBMPlexSansVar-Roman-Latin1.woff2` | `a18d94ea83c93f0a465d0976d8bc8ecbb031225dbaf76fd201d4e724a972034f` | 68988 | as released |
| `ibm-plex-sans/IBMPlexSansVar-Roman-Latin2.woff2` | `53de8a1640c42f45de9483f816dfc71dad3e87c24fbd115f4c312b8eddf39545` | 44752 | as released |
| `ibm-plex-sans/IBMPlexSansVar-Roman-Latin3.woff2` | `f08bc033a4959fb5fbc75a678fe56d2cd72ab5664bb3e6e1a41ac8f0d881c551` | 18576 | as released |
| `ibm-plex-sans/IBMPlexSansVar-Roman-Greek.woff2` | `00744cd9c1ed63fe2a37fbc45707ce0b9bfa949315c6dd8cf1436301e0c3817d` | 29800 | as released |
| `ibm-plex-sans/IBMPlexSansVar-Roman-Cyrillic.woff2` | `9f9516a6454bb52d2c5a8da5c59c0ff87360a823e08774ccdbcc758268d6a199` | 72520 | as released |
| `ibm-plex-sans/IBMPlexSansVar-Roman-Pi.woff2` | `0273a6b0411acbccb52b7d55af2bae2c58b35d68d6795a28c2f4db7ab21accbc` | 23900 | as released |
| `jetbrains-mono/JetBrainsMono-VF.woff2` | `31ec365b93e4bad6f202ce23352a56d01ca4462b2afc782ed2cf6fa42ca9ac0e` | 113672 | as released |
| `ibm-plex-mono/IBMPlexMono-Regular.woff2` | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` | 49248 | as released |
| `ibm-plex-mono/IBMPlexMono-Medium.woff2` | `33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25` | 50400 | as released |
| `ibm-plex-mono/IBMPlexMono-SemiBold.woff2` | `6a825b4824c01cbb401e829e5a066a1818411bcb3538b5a5792c5ca9b82343c3` | 50600 | as released |
| `ibm-plex-mono/IBMPlexMono-Bold.woff2` | `ea576f38d05cc44cca48c45314984beb8cc1d2b886f58e1dce99f15dc344eb1d` | 50380 | as released |

Subset source: `InterVariable.ttf` sha256
`4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf` (inside
`Inter-4.1.zip`, sha256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`).
Rebuild with `python3 scripts/typography/subset-inter.py path/to/InterVariable.ttf`,
then re-run `python3 scripts/typography/measure-fonts.py`.

Conversion source: `GolosText[wght].ttf` sha256
`17bb58fb69aec2dfb047a2ebf52534023e9b688c97a6b7ac795b0a72912c2063` (184,292
bytes). Converted with fontTools 4.60.2
(`TTFont(path).flavor = "woff2"`; brotli), full cmap kept — 76,716 bytes, under
the 150 KB subset threshold. Then re-run
`python3 scripts/typography/measure-fonts.py`.

## Licence notes

- **Inter** is subset (latin / cyrillic / everything else, split by
  `unicode-range`) and keeps both axes and the layout features the product uses.
  OFL without a Reserved Font Name permits this; the subset keeps the upstream
  name table, copyright and licence records.
- **PT Root UI** carries the Reserved Font Name "PT Root UI VF". A modified
  version could not be served under that name, so the file is served
  byte-for-byte as upstream publishes it — never subset, never re-encoded. The
  `@font-face` family is our own alias ("Radaric PT Root UI"), which only names
  the CSS face and does not rename the font. The full "PT Root" family is a
  commercial ParaType product and is not used.
- **Martian Grotesk.** The binary's name table has no licence description, and
  its licence-URL record (nameID 14) points to a gist with Evil Martians' older
  commercial EULA (https://gist.github.com/romashamin/1eb129751d10e22a69a4c9679c0cbba6).
  The font's repository and its `v1.0.0` release publish it under OFL-1.1
  (`OFL.txt` at https://github.com/evilmartians/grotesk/blob/main/OFL.txt,
  GitHub licence detection: `OFL-1.1`), with no Reserved Font Name. The
  repository licence is the grant this product relies on; the stale nameID 14 is
  an upstream metadata leftover, and the copy of `OFL.txt` here is the
  repository's.
- **Martian Mono** carries the OFL in both its repository and its name table.
- **IBM Plex Sans and IBM Plex Mono** carry the Reserved Font Name "Plex". A
  modified version could not be served under that name, so both are served
  byte-for-byte as IBM publishes them — never subset, never re-encoded, never
  renamed inside the font. The `@font-face` family is our own alias ("Radaric
  IBM Plex Sans" / "Radaric IBM Plex Mono"), which only names the CSS face. The
  Sans ships IBM's six official upright splits (Latin1/Latin2/Latin3/Greek/
  Cyrillic/Pi) so `unicode-range` downloads only the scripts a page needs; the
  Mono ships four complete static weights (400/500/600/700) — the only form IBM
  publishes for it.
- **JetBrains Mono** is OFL-1.1 with no Reserved Font Name (the licence file in
  its repository and release archive). The shipped file is the upright variable
  webfont (`wght` 100–800) from the repository, byte-for-byte; the `v2.304`
  release archive carries only static per-weight webfonts, so the variable
  woff2 is pinned to the repository commit named in the table above.
- **Golos Text** is OFL-1.1 with no Reserved Font Name, so it is converted from
  Google Fonts' variable TTF to woff2 with fontTools (no subsetting — the
  result is under the threshold). The conversion keeps the name table,
  copyright and licence records; both the source TTF and the shipped woff2
  hashes are recorded above.
