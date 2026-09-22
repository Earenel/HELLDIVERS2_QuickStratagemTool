import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CatalogStore } from "../lib/store.mjs";
import { NoticeStore } from "../lib/notices.mjs";
import { createCatalogServer, validateBundledIcons } from "../server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hd2-catalog-server-"));
  const store = new CatalogStore({
    dataRoot: directory,
    seedPath: path.join(root, "data", "seed-catalog.json"),
    privateKeyPath: path.join(directory, "keys", "private.pem"),
    publicKeyPath: path.join(directory, "keys", "public.pem"),
  });
  await store.initialize();
  const noticeStore = new NoticeStore({ dataRoot: path.join(directory, 'notices'), privateKey: store.privateKey, publicKey: store.publicKey, seedImagePath: path.join(root, 'data/resale-listing.jpg') });
  await noticeStore.initialize();
  const server = createCatalogServer({
    store,
    noticeStore,
    access: { authenticate: async () => ({ email: "owner@example.com" }) },
    bundledIconRoot: path.join(root, "bundled-icons"),
    publicOrigin: "https://update.example.test",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${address.port}`, store, noticeStore };
}

test("public manifest and immutable catalog are available", async (t) => {
  const { base } = await fixture(t);
  const manifestResponse = await fetch(`${base}/api/v1/stratagems/manifest`);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.catalogVersion, 1);
  assert.match(manifestResponse.headers.get("cache-control"), /max-age=60/);
  assert.equal(manifestResponse.headers.get("x-content-type-options"), "nosniff");
  const catalogResponse = await fetch(`${base}${manifest.catalogPath}`);
  assert.equal((await catalogResponse.json()).items.length, 101);
  assert.match(catalogResponse.headers.get("cache-control"), /immutable/);
});

test("notice images publish independently with CSRF, signature, and conflict checks", async (t) => {
  const { base, store, noticeStore } = await fixture(t);
  const { verify } = await import('node:crypto');
  const initial = await (await fetch(`${base}/admin/api/notices`)).json();
  assert.equal(initial.content.items[0].caption, '闲鱼-影子sam-通过倒卖牟利');
  const manifest = await (await fetch(`${base}/api/v1/notices/manifest`)).json();
  const bytes = Buffer.from(await (await fetch(`${base}${manifest.contentPath}`)).arrayBuffer());
  assert.ok(verify(null, bytes, store.publicKey, Buffer.from(manifest.signature, 'base64')));
  assert.equal((await fetch(`${base}/api/v1/notices/content/999`)).status, 404);
  const body = JSON.stringify({ baseVersion: 1, items: initial.content.items });
  assert.equal((await fetch(`${base}/admin/api/notices`, { method:'PUT', headers:{'content-type':'application/json'}, body })).status, 403);
  const headers = {'content-type':'application/json', 'x-hd2-admin':'1', origin:'https://update.example.test'};
  const uploaded = await fetch(`${base}/admin/api/notices/image`, {method:'POST', headers, body:JSON.stringify(initial.content.items[0].image)});
  assert.equal(uploaded.status, 200);
  const image = (await uploaded.json()).image;
  assert.equal(image.mediaType, 'image/jpeg');
  const items = [...initial.content.items, {id:'another-listing', caption:'<script>literal caption</script>', image}];
  const update = await fetch(`${base}/admin/api/notices`, {method:'PUT', headers, body:JSON.stringify({baseVersion:1,items})});
  assert.equal(update.status, 200);
  assert.equal((await update.json()).manifest.noticeVersion, 2);
  assert.equal((await store.currentManifest()).catalogVersion, 1, 'notice updates must never publish a stratagem version');
  assert.equal((await fetch(`${base}/admin/api/notices`, {method:'PUT',headers,body})).status, 409);
  assert.equal((await fetch(`${base}/admin/api/notices/image`, {method:'POST',headers,body:JSON.stringify({mediaType:'image/svg+xml',base64:'PHN2Zy8+'})})).status, 400);
  assert.equal((await fetch(`${base}/admin/api/notices/image`, {method:'POST',headers,body:JSON.stringify({mediaType:'image/jpeg',base64:'/9j/'})})).status, 400);
  assert.equal((await fetch(`${base}/admin/api/notices`, {method:'PUT',headers,body:JSON.stringify({baseVersion:2,items:[]})})).status, 200);
  assert.equal((await noticeStore.current()).content.items.length, 0);
  assert.equal((await (await fetch(`${base}${manifest.contentPath}`)).json()).items.length, 1, 'old content versions stay immutable');
});

test("admin publishes with CSRF checks and optimistic concurrency", async (t) => {
  const { base } = await fixture(t);
  const current = await (await fetch(`${base}/admin/api/catalog`)).json();
  const denied = await fetch(`${base}/admin/api/catalog`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseVersion: 1, items: current.catalog.items }),
  });
  assert.equal(denied.status, 403);
  const published = await fetch(`${base}/admin/api/catalog`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-hd2-admin": "1",
      origin: "https://update.example.test",
    },
    body: JSON.stringify({ baseVersion: 1, items: current.catalog.items }),
  });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).manifest.catalogVersion, 2);
});

test("admin serves only allowlisted assets and safe bundled icon names", async (t) => {
  const { base } = await fixture(t);
  assert.equal((await fetch(`${base}/admin/`)).status, 200);
  assert.equal((await fetch(`${base}/admin/app.js`)).status, 200);
  const stylesheet = await (await fetch(`${base}/admin/styles.css`)).text();
  assert.match(stylesheet, /\.catalog-pane[^}]*min-height:\s*0/s);
  assert.match(stylesheet, /\.catalog-list\s*{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  assert.equal((await fetch(`${base}/admin/secret.txt`)).status, 404);
  const icon = await fetch(`${base}/admin/api/bundled-icon/Machine_Gun_Stratagem_Icon.svg`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml");
  assert.match(await icon.text(), /<svg\b/i);
  assert.equal((await fetch(`${base}/admin/api/bundled-icon/..%2Fsecret.svg`)).status, 404);
  assert.equal((await fetch(`${base}/admin/api/bundled-icon/not-present.svg`)).status, 404);
});

test("startup validation rejects an incomplete bundled icon package", async (t) => {
  const { store } = await fixture(t);
  const emptyDirectory = await mkdtemp(path.join(os.tmpdir(), "hd2-empty-icons-"));
  t.after(() => rm(emptyDirectory, { recursive: true, force: true }));
  await assert.rejects(
    validateBundledIcons(store, emptyDirectory),
    /Bundled icon validation failed \(101 missing\)/,
  );
  assert.equal(await validateBundledIcons(store, path.join(root, "bundled-icons")), 101);
});

test("admin can be fail-closed while public catalog remains available", async (t) => {
  const { base, store } = await fixture(t);
  const server = createCatalogServer({
    store,
    access: { authenticate: async () => { throw new Error("must not run"); } },
    bundledIconRoot: path.join(root, "bundled-icons"),
    publicOrigin: "https://update.example.test",
    adminDisabled: true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/admin/`)).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/stratagems/manifest`)).status, 200);
});
