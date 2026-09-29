/** The sidekick's loading lines. */
export const QUIPS = {
  connecting: [
    "Asking the station nicely…",
    "Knocking on the station's front door…",
    "Checking the session is still warm…",
    "Shaking hands with the web service…"
  ],
  browsing: ["Walking the station tree…", "Counting the VAVs…", "Opening folders carefully…"],
  searching: ["Looking under every folder…", "Asking every point if it's the one…", "Checking behind the Drivers folder…"],
  history: ["Rolling up the trends…", "Averaging out the bumps…", "Digging through the history database…"],
  alarms: ["Reading the alarm console…", "Checking who hasn't acked…"],
  writing: ["Waiting for the point to make up its mind…", "Checking who else is commanding it…"]
} as const;

export type QuipKind = keyof typeof QUIPS;

export function quip(kind: QuipKind): string {
  const lines = QUIPS[kind];
  return lines[Math.floor(Math.random() * lines.length)];
}
