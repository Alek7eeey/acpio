# SPEC — roman numeral conversion

## toRoman(n)

- Accepts an integer `1..3999` and returns its canonical uppercase roman
  numeral in minimal form — the only subtractive pairs ever produced are
  `CM`, `CD`, `XC`, `XL`, `IX`, `IV`.
- Throws `RangeError` for: non-integers (e.g. `2.5`), `0`, negative numbers,
  and anything above `3999`.

Exact canonical strings that must hold: `1→I`, `4→IV`, `9→IX`, `14→XIV`,
`40→XL`, `90→XC`, `400→CD`, `900→CM`, `1994→MCMXCIV`, `3999→MMMCMXCIX`.

## toArabic(s)

- Accepts a canonical uppercase numeral (characters `MDCLXVI` only) and
  returns its value, subtractive pairs included: `MCMXCIV→1994`,
  `CMXLIV→944`.
- Throws `RangeError` for: a non-string, the empty string, lowercase input
  (`xiv`), and any character outside `MDCLXVI`.

## Round trip

- `toArabic(toRoman(n)) === n` for every `n` in `1..3999`.
