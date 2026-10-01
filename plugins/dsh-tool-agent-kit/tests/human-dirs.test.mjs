import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWrite, checkMove, humanDirsFrom } from "../lib/human-dirs.js";

const HUMAN = "/mem/human", AGENT = "/mem/agent";

test("запись в человеческий каталог отклоняется", () => {
  const v = checkWrite(HUMAN + "/note.md", { humanDirs: [HUMAN] });
  assert.equal(v.ok, false);
  assert.equal(v.code, "human_dir_write");
});

test("симлинк из агентского каталога в человеческий отклоняется", () => {
  const v = checkWrite(AGENT + "/link.md", {
    humanDirs: [HUMAN],
    realpath: (p) => (p === AGENT + "/link.md" ? HUMAN + "/note.md" : p),
    lstat: () => ({ isSymbolicLink: () => true }),
  });
  assert.equal(v.ok, false);
  assert.ok(["symlink_to_human", "human_dir_write"].includes(v.code), "симлинк в человеческий каталог обязан быть отклонён");
});

test("обход через .. отклоняется", () => {
  const v = checkWrite(AGENT + "/../human/note.md", { humanDirs: [HUMAN] });
  assert.equal(v.ok, false);
  assert.equal(v.code, "path_traversal");
});

test("переименование в человеческий каталог отклоняется (проверяются обе стороны)", () => {
  const v = checkMove(AGENT + "/a.md", HUMAN + "/a.md", { humanDirs: [HUMAN], realpath: (p) => p });
  assert.equal(v.ok, false);
  assert.equal(v.code, "human_dir_write");
});

test("жёсткая ссылка внутри человеческого каталога помечается риском", () => {
  const v = checkWrite(HUMAN + "/x.md", {
    humanDirs: [HUMAN],
    realpath: (p) => (p.endsWith("/x.md") ? "/mem/elsewhere/x.md" : p),
    lstat: () => ({ isSymbolicLink: () => false, nlink: 2 }),
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, "hardlink_risk");
});

test("обычная запись в агентский каталог разрешена", () => {
  const v = checkWrite(AGENT + "/note.md", { humanDirs: [HUMAN], realpath: (p) => p });
  assert.equal(v.ok, true);
});

test("humanDirs берутся из подписанного конфига, а не из неподписанного", () => {
  assert.deepEqual(humanDirsFrom({ humanDirs: [HUMAN], signed: true }), [HUMAN]);
  assert.deepEqual(humanDirsFrom({ humanDirs: [HUMAN], signed: false, defaults: [AGENT] }), [AGENT]);
});
