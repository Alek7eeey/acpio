# clip — trim long text to a width

CLI: `node clip.js <text | @file> --width N [--at word|char] [--marker "..."]`

- `--width N` — required. The printed result is never longer than N
  characters.
- `--at word|char` — default `char`. In `word` mode the cut lands on a word
  boundary: the result contains only whole words joined by single spaces, no
  trailing spaces, and is still within the width.
- `--marker "..."` — default `…`. When the text does not fit, the marker is
  appended to mark the cut, and the marker counts toward the width. Text
  that fits (length ≤ N) passes through unchanged, without the marker.
- `@file` — read the text from a file instead of the command line
  (a single trailing newline in the file is not part of the text).
- No text and no `@file` (or a missing/invalid `--width`): print the usage
  line to **stderr** and exit with code **1**.
