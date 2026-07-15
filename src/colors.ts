export const C = {
  bg:           "#1a1b26",
  border:       "#3d59a1",
  borderBright: "#7aa2f7",
  headerFg:     "#565f89",
  sepFg:        "#1e2030",
  rowFg:        "#a9b1d6",
  childFg:      "#6b7699",
  selectedBg:   "#2d4f91",
  selectedFg:   "#c0caf5",
  detailPathFg: "#7aa2f7",
  detailTextFg: "#9aa5ce",
  searchFg:       "#7aa2f7",
  searchHl:       "#e0af68", // Tokyo Night yellow — search match highlight
  searchActiveBg: "#1e2030", // subtle panel lift when search bar is focused
} as const

// ANSI escape for inline text highlighting (used in snippet strings)
export const ANSI = {
  searchHl: `\x1b[38;2;224;175;104m`, // searchHl in ANSI RGB form
  reset:    `\x1b[0m`,
} as const
