import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing library source: ${start}`);
  return source.slice(from, to);
}
function element() {
  return {
    children: [], style: {}, value: "", scrollTop: 100,
    set innerHTML(value) { this.html = value; this.children = []; },
    get innerHTML() { return this.html || ""; },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this[name] = value; },
  };
}
const elements = new Map(["lib-content", "lib-search-input", "lib-search-hint"].map(id => [id, element()]));
const saves = [];
const clicks = [];
const context = vm.createContext({
  document: { createElement: element, getElementById: id => elements.get(id) },
  saveDataToLocal: (filename, data) => saves.push({ filename, data: JSON.parse(JSON.stringify(data)) }),
  showToast() {},
  escapeHtml: value => String(value).replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
  safeImageSource: value => value,
  commitLoadoutChange: () => clicks.push("loadout"),
  confirmDeleteCustom: id => clicks.push(id),
  closeConfirmModal() {},
});
context.window = context;
vm.runInContext(`
  ${section("const i18n =", "const defaultStratagemDB")}
  let currentLang = 'zh';
  let gameSettings = { favoriteStratagemIds: [], menuKey: 'ControlLeft', overlayPosition: { x: 12, y: 34 } };
  let stratagemDB = [
    { id: 'support_a', grp: 'support', name: { zh: '测试机枪', en: 'Test gun' }, aliases: ['gun alias'], icon: 'gun.svg' },
    { id: 'eagle_a', grp: 'eagle', name: { zh: '测试空袭', en: 'Test strike' }, aliases: [], icon: 'eagle.svg' },
    { id: 'custom_a', grp: 'support', name: { zh: '自定义', en: 'Custom' }, aliases: [], icon: 'custom.svg' },
    { id: 'disabled_a', grp: 'support', enabled: false, name: { zh: '停用', en: 'Disabled' }, aliases: [], icon: 'disabled.svg' }
  ];
  let customStratagems = [stratagemDB[2]];
  let activeLoadout = [{ strat: null, locked: false }];
  let pendingDelete = { type: 'custom', payload: 'custom_a' };
  function rebuildStratagemDatabase() { stratagemDB = stratagemDB.filter(s => !s.id.startsWith('custom_')).concat(customStratagems); }
  ${section("function normalizeFavoriteStratagemIds", "window.closeModals =")}
  ${section("window.executeDelete =", "let currentUploadBase64")}
`, context);
const run = script => vm.runInContext(script, context);
const plain = script => JSON.parse(JSON.stringify(run(script)));
const container = elements.get("lib-content");
const headers = () => container.children.filter(el => el.className === "lib-cat-header").map(el => el.textContent);
const cards = () => container.children.filter(el => el.className === "lib-grid").flatMap(grid => grid.children);

for (const invalid of [undefined, null, true, "support_a", {}]) {
  context.persisted = invalid;
  assert.deepEqual(plain("normalizeFavoriteStratagemIds(persisted)"), []);
}
assert.deepEqual(plain("normalizeFavoriteStratagemIds(['support_a', null, 'support_a', 3, '', '<bad>', 'custom_a'])"), ["support_a", "custom_a"]);
assert.match(source, /favoriteStratagemIds: \[\]/, "old settings should start without favorites");
assert.match(section("async function initData()", "window.handleToggleOverlay"), /gameSettings\.favoriteStratagemIds = favoriteIds/);
assert.match(source, /getElementById\('txt-lib-favorite-hint'\)\.textContent = lang\.libFavoriteHint/);
for (const language of ["zh", "en"]) {
  assert.ok(run(`i18n.${language}.libFavoriteHint.length > 0 && i18n.${language}.cat_favorites.length > 0`));
}

run("renderLibrary()");
assert.equal(headers()[0], "支援武器");
let prevented = false;
cards()[0].oncontextmenu({ preventDefault() { prevented = true; } });
assert.ok(prevented, "right-click must suppress the native context menu");
assert.deepEqual(plain("gameSettings.favoriteStratagemIds"), ["support_a"]);
assert.equal(headers()[0], "最爱");
assert.equal(container.scrollTop, 0);
assert.match(cards()[0].innerHTML, /★/);
assert.deepEqual(clicks, [], "favoriting must not equip or delete a stratagem");
assert.equal(saves.at(-1).filename, "settings.json");
assert.equal(saves.at(-1).data.menuKey, "ControlLeft");
assert.deepEqual(saves.at(-1).data.overlayPosition, { x: 12, y: 34 });

context.persisted = saves.at(-1).data;
run("gameSettings = JSON.parse(JSON.stringify(persisted)); gameSettings.favoriteStratagemIds = normalizeFavoriteStratagemIds(gameSettings.favoriteStratagemIds); renderLibrary()");
assert.equal(headers()[0], "最爱", "saved favorites must survive settings reload");
cards()[0].onclick();
assert.equal(run("activeLoadout[0].strat.id"), "support_a");
assert.equal(cards().filter(card => card.className.includes("selected")).length, 2, "favorite and original cards must share selection state");
assert.deepEqual(plain("gameSettings.favoriteStratagemIds"), ["support_a"]);

elements.get("lib-search-input").value = "Test";
run("renderLibrary('Test')");
assert.deepEqual(headers(), ["最爱", "搜索结果"]);
assert.equal(cards().length, 2, "search results should not duplicate favorites");
run("renderLibrary('gun alias')");
assert.equal(elements.get("lib-search-hint").style.display, "block");
assert.equal(cards().length, 1);
run("renderLibrary('no match')");
assert.equal(cards().length, 0, "nonmatching favorites must not bypass search");

elements.get("lib-search-input").value = "Test";
run("renderLibrary('Test')");
cards()[0].oncontextmenu({ preventDefault() {} });
assert.equal(elements.get("lib-search-input").value, "Test");
assert.deepEqual(headers(), []);
assert.deepEqual(plain("gameSettings.favoriteStratagemIds"), []);
assert.equal(run("activeLoadout[0].strat.id"), "support_a", "unfavoriting must preserve the loadout");

run("gameSettings.favoriteStratagemIds = ['disabled_a', 'temporarily_missing']; renderLibrary()");
assert.ok(!headers().includes("最爱"));
run("toggleFavoriteStratagem('disabled_a'); toggleFavoriteStratagem('unknown')");
assert.deepEqual(plain("gameSettings.favoriteStratagemIds"), ["disabled_a", "temporarily_missing"]);

elements.get("lib-search-input").value = "";
run("gameSettings.favoriteStratagemIds = []; renderLibrary()");
let customCard = cards().find(card => card.children.some(child => child.className === "lib-delete"));
customCard.oncontextmenu({ preventDefault() {} });
assert.deepEqual(plain("gameSettings.favoriteStratagemIds"), ["custom_a"]);
assert.deepEqual(clicks, ["loadout"], "right-clicking custom cards must only favorite");
customCard = cards()[0];
let stopped = false;
customCard.children[0].onclick({ stopPropagation() { stopped = true; } });
assert.ok(stopped);
assert.equal(clicks.at(-1), "custom_a", "custom deletion must remain reachable through its button");
run("executeDelete()");
assert.deepEqual(plain("gameSettings.favoriteStratagemIds"), []);
assert.equal(run("stratagemDB.some(s => s.id === 'custom_a')"), false);
assert.ok(saves.some(save => save.filename === "custom_strats.json" && save.data.length === 0));
run("currentLang = 'en'; toggleFavoriteStratagem('eagle_a')");
assert.equal(headers()[0], "FAVORITES");
assert.equal(cards()[0].title, "Right-click to unfavorite");
console.log("Library favorites: persistence, search, selection, localization, and custom deletion passed.");
