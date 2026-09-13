import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const i18nSource = source.slice(source.indexOf("const i18n ="), source.indexOf("const defaultStratagemDB"));
const supportSource = source.slice(source.indexOf("window.openGitHubRepository ="), source.indexOf("window.handleSearch ="));
assert.ok(i18nSource.length > 0 && supportSource.length > 0);
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ count = 10, language = "zh", updatePending = false } = {}) {
  const elements = new Map();
  const observers = new Set();
  const errors = [];
  let releaseUpdate;
  const calls = { open: 0, dismiss: 0 };
  const api = {
    takeStartupStarReminder: async () => count,
    openGitHubRepository: async () => { calls.open++; },
    dismissStarReminders: async () => { calls.dismiss++; },
  };
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id, disabled: false, textContent: "",
        classList: {
          contains: value => classes.has(value),
          add(value) { classes.add(value); queueMicrotask(() => observers.forEach(observer => observer.callback())); },
          remove(value) { classes.delete(value); queueMicrotask(() => observers.forEach(observer => observer.callback())); },
        },
        focus() {}, addEventListener() {},
      });
    }
    return elements.get(id);
  }
  for (const id of ["sponsor-modal", "star-reminder-modal", "update-modal"]) element(id);
  const context = vm.createContext({
    window: { electronAPI: api },
    document: {
      getElementById: element,
      querySelector: () => [...elements.values()].find(el => el.id.endsWith("-modal") && el.classList.contains("active")),
      querySelectorAll: () => [...elements.values()].filter(el => el.id.endsWith("-modal")),
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    checkForStartupUpdate: updatePending
      ? () => new Promise(resolve => { releaseUpdate = resolve; })
      : async () => {},
    checkForStratagemCatalogUpdate: async () => {},
    showInlineStatus: message => errors.push(message),
  });
  vm.runInContext(`let currentLang = ${JSON.stringify(language)};
    let pendingStarReminderCount = null, starReminderObserver = null, starReminderBusy = false;
    ${i18nSource}
    ${supportSource}`, context);
  return { context, api, element, observers, errors, calls,
    prepare: () => vm.runInContext("prepareStartupStarReminder()", context),
    release: () => releaseUpdate(),
    visible: () => element("star-reminder-modal").classList.contains("active"),
  };
}

for (const count of [null, 1, 9, 11, 19, 21, 49, 51, 100, "10"]) {
  const h = harness({ count });
  await h.prepare();
  assert.equal(h.visible(), false, `no reminder for ${count}`);
  assert.equal(h.observers.size, 0);
}
for (const language of ["zh", "en"]) {
  for (const count of [10, 20, 50]) {
    const h = harness({ count, language });
    await h.prepare();
    assert.equal(h.visible(), true);
    assert.match(h.element("txt-star-msg").textContent, new RegExp(String(count)));
    assert.equal(h.element("btn-star-dismiss").textContent, language === "zh" ? "不再显示" : "Don't show again");
    assert.equal(h.observers.size, 0, "observer must stop after showing the reminder");
  }
}
const deferred = harness({ updatePending: true });
const preparing = deferred.prepare();
await flush();
assert.equal(deferred.visible(), false, "wait for update checks");
deferred.element("update-modal").classList.add("active");
deferred.release();
await preparing;
assert.equal(deferred.visible(), false, "do not cover the update dialog");
deferred.element("update-modal").classList.remove("active");
await flush();
assert.equal(deferred.visible(), true);

for (const language of ["zh", "en"]) {
  const h = harness({ language });
  await h.prepare();
  h.api.dismissStarReminders = async () => { throw new Error("disk full"); };
  await h.context.window.dismissStarReminders();
  assert.equal(h.visible(), true, "failed persistence must leave a retry available");
  assert.equal(h.element("btn-star-dismiss").disabled, false);
  assert.match(h.errors.at(-1), language === "zh" ? /请重试/ : /try again/);
  h.api.dismissStarReminders = async () => { h.calls.dismiss++; };
  await h.context.window.dismissStarReminders();
  assert.equal(h.visible(), false);
  assert.equal(h.calls.dismiss, 1);
}
const link = harness();
await link.prepare();
link.api.openGitHubRepository = async () => { throw new Error("browser unavailable"); };
await link.context.window.goToStarRepository();
assert.equal(link.visible(), true);
link.api.openGitHubRepository = async () => { link.calls.open++; };
await link.context.window.goToStarRepository();
assert.equal(link.visible(), false);
assert.equal(link.calls.open, 1);
assert.equal(link.calls.dismiss, 0, "opening GitHub does not silently opt out of future milestones");

assert.match(source, /赞助全凭自愿，但如果可以的话烦请在Github点一个star吧/);
assert.match(source, /href="https:\/\/github.com\/Ooxygen7\/HELLDIVERS2_QuickStratagemTool"/);
const image = fs.readFileSync(new URL("../ui/assets/sponsor-code.png", import.meta.url));
assert.equal(image.subarray(1, 4).toString(), "PNG");
assert.equal(image.readUInt32BE(16), 1221);
assert.equal(image.readUInt32BE(20), 1221);
console.log("Support reminders: milestones, localization, dialog ordering, errors, and opt-out UI passed.");
