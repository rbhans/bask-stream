// The name matcher: splits a BAS name into words, expands the common abbreviations, and scores how
// close two names are. It is the matcher behind check_px_bindings, which lives in the station module
// (BaskStreamGraphicsResolver.java: SYNONYMS, tokens, nameScore), written again here with the same
// table and the same sums so that bask can match names without asking the station. Keep the two alike.

/** Words BAS point names abbreviate: each row's first word is the one the others are compared as. */
const TABLE: string[][] = [
  ["temp", "temperature", "tmp", "tem", "t"], ["setpoint", "sp", "stpt", "spt", "setpt", "set"],
  ["space", "zone", "zn", "room", "rm", "spc", "zon"], ["occupied", "occ", "occupancy"],
  ["unoccupied", "unocc", "unocupied"], ["command", "cmd", "cmnd"], ["status", "sts", "stat", "stts"],
  ["position", "pos", "posn"], ["damper", "dmpr", "dpr", "dmp"], ["flow", "cfm", "airflow"],
  ["heat", "htg", "heating", "ht"], ["cool", "clg", "cooling", "cl"], ["supply", "sup", "sply", "discharge", "dis", "dsch"],
  ["return", "ret", "rtn"], ["outside", "oa", "outdoor", "osa", "out"], ["mixed", "mix", "mxd"], ["exhaust", "exh", "ea"],
  ["speed", "spd"], ["valve", "vlv", "vlve"], ["humidity", "hum", "rh", "humid"], ["pressure", "press", "pres", "prs"],
  ["fan", "fn"], ["effective", "eff", "effect"], ["alarm", "alm", "alrm"], ["enable", "en", "enab", "ena"],
  ["minimum", "min"], ["maximum", "max"], ["co2", "carbondioxide"], ["static", "stat_pressure"],
  ["filter", "filt", "flt"], ["pump", "pmp"], ["chilled", "chw", "chill"], ["water", "wtr", "h2o"],
  ["reheat", "rht", "rh_valve"], ["actual", "act"], ["differential", "diff", "dp"]
];
const SYNONYMS = new Map<string, string[]>();
for (const row of TABLE) for (const word of row) SYNONYMS.set(word, [row[0]]);
// Abbreviations that stand for more than one word.
for (const [short, words] of [
  ["sat", "supply air temp"], ["dat", "supply air temp"], ["rat", "return air temp"], ["mat", "mixed air temp"], ["oat", "outside air temp"],
  ["sa", "supply air"], ["da", "supply air"], ["ra", "return air"], ["ma", "mixed air"],
  ["zt", "space temp"], ["st", "space temp"], ["rmt", "space temp"], ["znt", "space temp"]
]) SYNONYMS.set(short, words.split(" "));

/** A word the matcher knows: a BAS word or one of its abbreviations ("temp", "sp", "sat"). */
export const isBasWord = (word: string): boolean => SYNONYMS.has(word.toLowerCase());

/** Where a name breaks into words: anything but letters and digits, a lower-to-upper step, and letters meeting digits. */
const WORDS = /[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/;

/** A name as lower-case words with abbreviations spelled out: "SAT_Stpt" → supply, air, temp, setpoint. */
export function tokens(name: string): string[] {
  const out: string[] = [];
  for (const word of name.split(WORDS)) {
    if (!word) continue;
    const lower = word.toLowerCase();
    out.push(...(SYNONYMS.get(lower) ?? [lower]));
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_v, j) => j);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

const digits = (text: string) => text.replace(/[^0-9]+/g, " ").trim();

/** 0..1: shared words (Dice) blended with how close the spelled-out names are. Digits must agree, or the score is halved. */
export function nameScore(a: string[], rawA: string, b: string[], rawB: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const rest = [...b];
  let shared = 0;
  for (const word of a) {
    const at = rest.indexOf(word);
    if (at < 0) continue;
    rest.splice(at, 1);
    shared += 1;
  }
  const dice = (2 * shared) / (a.length + b.length);
  const joinedA = a.join("");
  const joinedB = b.join("");
  const longest = Math.max(joinedA.length, joinedB.length);
  const spelled = longest === 0 ? 0 : 1 - levenshtein(joinedA, joinedB) / longest;
  const score = 0.6 * dice + 0.4 * spelled;
  // VAV_2 is not VAV_12, and Fan1 is not Fan2.
  return digits(rawA) === digits(rawB) ? score : 0.5 * score;
}
