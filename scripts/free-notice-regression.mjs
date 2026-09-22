import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../ui/free-notice.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness({ first = false, update = null, failSave = false } = {}) {
  const elements = new Map();
  function node() {
    const classes = new Set();
    return { children: [], textContent: '', classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, focus() {}, addEventListener() {},
    };
  }
  function element(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); }
  const calls = [];
  const api = {
    loadCachedFreeNotice: async () => null,
    checkFreeNoticeUpdates: async () => update,
    shouldShowFreeNotice: async () => first,
    acknowledgeFreeNotice: async () => { calls.push('ack'); if (failSave) throw new Error('disk full'); },
    openBilibiliPage: async () => calls.push('bilibili'),
    openGitHubRepository: async () => calls.push('github'),
  };
  const context = vm.createContext({ document: { getElementById: element, createElement: node, createTextNode: text => ({textContent:text}) }, window: {electronAPI:api} });
  vm.runInContext(source, context);
  return { notice:context.window.freeSoftwareNotice, api, calls, element, setFail: value => { failSave = value; } };
}

const fresh = harness({first:true,failSave:true});
let complete = false;
const pending = fresh.notice.initialize('zh').then(() => { complete = true; });
await flush();
assert.ok(fresh.element('free-notice-first-modal').classList.contains('active'));
assert.equal(fresh.element('free-notice-first-text').textContent, '本软件是免费、开源的软件。所有付费售卖者均为倒卖。');
assert.equal(fresh.element('free-notice-ack').textContent, '收到，不再显示。');
await fresh.element('free-notice-ack').onclick();
assert.equal(complete, false);
assert.ok(fresh.element('free-notice-first-error').textContent);
fresh.setFail(false);
await fresh.element('free-notice-ack').onclick();
await pending;
assert.equal(complete,true);
assert.equal(fresh.element('free-notice-first-modal').classList.contains('active'),false);

const update = {noticeVersion:2,items:[{id:'new',caption:'<img onerror=alert(1)>',image:{mediaType:'image/jpeg',base64:'/9j/'}}]};
const existing = harness({update});
await existing.notice.initialize('en'); await flush();
assert.equal(existing.element('free-notice-first-modal').classList.contains('active'),false);
assert.equal(existing.element('free-notice-modal').classList.contains('active'),false,'background updates must not open any notice');
existing.notice.open();
assert.equal(existing.element('free-notice-items').children[0].children[0].textContent, '<img onerror=alert(1)>', 'captions must render as text');
assert.equal(existing.element('free-notice-title').textContent,'READ ME');
const links = existing.element('free-notice-statement').children.filter(child => child.href);
await links[0].onclick({preventDefault(){}}); await links[1].onclick({preventDefault(){}});
assert.deepEqual(existing.calls,['bilibili','github']);

const offline = harness();
offline.api.loadCachedFreeNotice = async () => { throw new Error('cache unavailable'); };
offline.api.checkFreeNoticeUpdates = async () => { throw new Error('offline'); };
await offline.notice.initialize('zh'); await flush(); offline.notice.open();
assert.equal(offline.element('free-notice-items').children[0].children[1].src,'./assets/resale-listing.jpg');
assert.equal(offline.element('free-notice-items').children[0].children[0].textContent,'闲鱼-影子sam-通过倒卖牟利');
console.log('Free notice: first-run acknowledgement, upgrade compatibility, silent updates, safe text, official links, and offline fallback passed.');
