// Light or dark: what the environment says and how a terminal's answers are read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { askTerminalTheme, setTheme, theme, themeFromEnvironment, themeFromReply } from "../dist/tui/theme.js";

test("a terminal's background colour decides light or dark, and its colour scheme when it gives no background", () => {
  // tmux, light pane and dark pane (as captured from tmux 3.8).
  assert.equal(themeFromReply("\x1b]11;rgb:fafa/fafa/fafa\x1b\\\x1b[?997;2n\x1b[?1;2;4c"), "light");
  assert.equal(themeFromReply("\x1b]11;rgb:1010/1212/1818\x1b\\\x1b[?997;1n\x1b[?1;2;4c"), "dark");
  // Rex gives the scheme alone (as captured from Rex 0.1.0-preview.14).
  assert.equal(themeFromReply("\x1b[?997;1n\x1b[?62;22c"), "dark");
  assert.equal(themeFromReply("\x1b[?997;2n\x1b[?62;22c"), "light");
  // Short and long colour forms, with or without alpha, ended by BEL.
  assert.equal(themeFromReply("\x1b]11;rgb:ff/ff/ff\x07"), "light");
  assert.equal(themeFromReply("\x1b]11;rgba:0000/0000/0000/ffff\x07"), "dark");
  assert.equal(themeFromReply("\x1b]11;rgb:f/f/f\x07"), "light");
  // Brightness is weighed the way the eye sees it: a strong blue is still a dark background.
  assert.equal(themeFromReply("\x1b]11;rgb:0000/0000/ffff\x07"), "dark");
  assert.equal(themeFromReply("\x1b]11;rgb:ffff/ffff/0000\x07"), "light");
  // The background wins when the two disagree: it is what the text sits on.
  assert.equal(themeFromReply("\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?997;1n"), "light");
  // A terminal that only says what it is.
  assert.equal(themeFromReply("\x1b[?62;22c"), undefined);
  assert.equal(themeFromReply(""), undefined);
});

test("BASK_THEME wins over COLORFGBG, and neither set leaves it to the terminal", () => {
  const saved = { BASK_THEME: process.env.BASK_THEME, COLORFGBG: process.env.COLORFGBG };
  try {
    delete process.env.BASK_THEME;
    delete process.env.COLORFGBG;
    assert.equal(themeFromEnvironment(), undefined);
    process.env.COLORFGBG = "0;15";
    assert.equal(themeFromEnvironment(), "light");
    process.env.COLORFGBG = "15;0";
    assert.equal(themeFromEnvironment(), "dark");
    process.env.COLORFGBG = "12;default;7";
    assert.equal(themeFromEnvironment(), "light");
    process.env.BASK_THEME = "Dark";
    assert.equal(themeFromEnvironment(), "dark");
    process.env.BASK_THEME = "light";
    process.env.COLORFGBG = "15;0";
    assert.equal(themeFromEnvironment(), "light");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("with no terminal to ask there is no answer, and the two colour sets differ", async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) assert.equal(await askTerminalTheme(50), undefined);
  setTheme("light");
  const light = { ...theme };
  setTheme("dark");
  assert.equal(theme.name, "dark");
  assert.equal(light.name, "light");
  for (const key of ["accent", "good", "warn", "bad", "muted", "selection"]) assert.notEqual(light[key], theme[key], key);
});
