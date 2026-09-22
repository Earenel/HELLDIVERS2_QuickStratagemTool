import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createHash, sign, verify } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { atomicWrite } from "./store.mjs";
import { SIGNING_ALGORITHM, SIGNING_KEY_ID, ID_PATTERN } from "./constants.mjs";

export const NOTICE_LIMITS = Object.freeze({ items: 20, imageBytes: 1024 * 1024, uploadBytes: 5 * 1024 * 1024, contentBytes: 8 * 1024 * 1024 });

function imageBytes(image, maximum) {
  if (!image || !["image/jpeg", "image/png"].includes(image.mediaType)
      || typeof image.base64 !== "string" || image.base64.length > Math.ceil(maximum / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) throw new TypeError("图片仅支持 JPEG 或 PNG");
  const bytes = Buffer.from(image.base64, "base64");
  if (!bytes.length || bytes.length > maximum || bytes.toString("base64") !== image.base64) throw new TypeError("图片大小或编码无效");
  return bytes;
}

export async function normalizeNoticeImage(upload) {
  const bytes = imageBytes(upload, NOTICE_LIMITS.uploadBytes);
  const image = sharp(bytes, { limitInputPixels: 24 * 1024 * 1024, failOn: "warning", pages: 1 });
  const metadata = await image.metadata().catch(() => { throw new TypeError("无法读取图片，请上传有效的 JPEG 或 PNG"); });
  if (!['jpeg', 'png'].includes(metadata.format) || `image/${metadata.format}` !== upload.mediaType) throw new TypeError("图片内容与格式不符");
  const jpeg = await image.rotate().resize({ width: 1800, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer().catch(() => { throw new TypeError("图片内容损坏，无法处理"); });
  if (jpeg.length > NOTICE_LIMITS.imageBytes) throw new TypeError("图片压缩后仍超过 1 MiB，请缩小图片后重试");
  return { mediaType: "image/jpeg", base64: jpeg.toString("base64") };
}

export async function normalizeNoticeItems(items) {
  if (!Array.isArray(items) || items.length > NOTICE_LIMITS.items) throw new TypeError("最多可发布 20 条图文");
  const ids = new Set();
  const result = [];
  let totalBytes = 0;
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !ID_PATTERN.test(item.id) || ids.has(item.id)) throw new TypeError("图文标识符无效或重复");
    if (typeof item.caption !== "string" || !item.caption.trim() || item.caption.length > 500) throw new TypeError("附文需为 1–500 个字符");
    const bytes = imageBytes(item.image, NOTICE_LIMITS.imageBytes);
    totalBytes += bytes.length;
    if (totalBytes * 4 / 3 > NOTICE_LIMITS.contentBytes - 32 * 1024) throw new TypeError("图文总大小超过 8 MiB");
    const metadata = await sharp(bytes, { limitInputPixels: 24 * 1024 * 1024, failOn: "warning" }).metadata().catch(() => { throw new TypeError("图片内容损坏，无法处理"); });
    if (!['jpeg', 'png'].includes(metadata.format) || `image/${metadata.format}` !== item.image.mediaType || (metadata.pages || 1) !== 1) throw new TypeError("图片格式无效");
    ids.add(item.id);
    result.push({ id: item.id, caption: item.caption.trim(), image: { mediaType: item.image.mediaType, base64: item.image.base64 } });
  }
  return result;
}

export class NoticeStore {
  constructor({ dataRoot, privateKey, publicKey, seedImagePath }) {
    this.root = path.resolve(dataRoot);
    this.versions = path.join(this.root, "versions");
    this.pointer = path.join(this.root, "current.json");
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.seedImagePath = seedImagePath;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.versions, { recursive: true });
    if (!existsSync(this.pointer)) {
      const image = { mediaType: "image/jpeg", base64: (await readFile(this.seedImagePath)).toString("base64") };
      await this.publish({ baseVersion: 0, items: [{ id: "xianyu-shadow-sam", caption: "闲鱼-影子sam-通过倒卖牟利", image }], actor: "system" });
    }
    const { manifest, content, bytes } = await this.current();
    if (manifest.noticeVersion !== content.noticeVersion || manifest.sha256 !== createHash("sha256").update(bytes).digest("hex")
        || !verify(null, bytes, this.publicKey, Buffer.from(manifest.signature, "base64"))) throw new Error("Notice signature is invalid");
    await normalizeNoticeItems(content.items);
  }

  async currentManifest() { return JSON.parse(await readFile(this.pointer, "utf8")); }
  async current() {
    const manifest = await this.currentManifest();
    return { manifest, ...await this.version(manifest.noticeVersion) };
  }
  async version(version) {
    if (!Number.isSafeInteger(version) || version < 1 || version > 9999999999) throw new TypeError("Invalid notice version");
    const bytes = await readFile(path.join(this.versions, `${version}.json`));
    return { bytes, content: JSON.parse(bytes.toString("utf8")) };
  }
  publish(input) {
    const operation = this.queue.then(() => this.publishNow(input));
    this.queue = operation.catch(() => {});
    return operation;
  }
  async publishNow({ baseVersion, items, actor }) {
    const current = existsSync(this.pointer) ? (await this.currentManifest()).noticeVersion : 0;
    if (baseVersion !== current) {
      const error = new Error("声明图文已更新，请重新载入后编辑");
      error.code = "VERSION_CONFLICT";
      error.currentVersion = current;
      throw error;
    }
    let version = current + 1;
    while (existsSync(path.join(this.versions, `${version}.json`))) version++;
    if (version > 9999999999) throw new Error("Notice version limit reached");
    const content = { schemaVersion: 1, noticeVersion: version, publishedAt: new Date().toISOString(), items: await normalizeNoticeItems(items) };
    const bytes = Buffer.from(JSON.stringify(content));
    if (bytes.length > NOTICE_LIMITS.contentBytes) throw new TypeError("图文总大小超过 8 MiB");
    const manifest = {
      schemaVersion: 1, noticeVersion: version, publishedAt: content.publishedAt,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signature: sign(null, bytes, this.privateKey).toString("base64"),
      signingAlgorithm: SIGNING_ALGORITHM, keyId: SIGNING_KEY_ID,
      contentPath: `/api/v1/notices/content/${version}`,
    };
    // Write immutable content and its audit record before atomically switching the pointer.
    await atomicWrite(path.join(this.versions, `${version}.json`), bytes);
    await atomicWrite(path.join(this.versions, `${version}.audit.json`), Buffer.from(JSON.stringify({ version, actor: String(actor).slice(0, 200), publishedAt: content.publishedAt, sha256: manifest.sha256 })));
    await atomicWrite(this.pointer, Buffer.from(JSON.stringify(manifest)));
    return { manifest, content };
  }
}
