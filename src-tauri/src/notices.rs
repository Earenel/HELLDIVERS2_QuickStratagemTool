use base64::{engine::general_purpose, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::Path};

use crate::{catalog, config, network};

const HOST: &str = "update.unsnow.online";
const MANIFEST_PATH: &str = "/api/v1/notices/manifest";
const CACHE_FILE: &str = "free-notice-cache.json";
const MAX_CONTENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    notice_version: u64,
    published_at: String,
    sha256: String,
    signature: String,
    signing_algorithm: String,
    key_id: String,
    content_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoticeContent {
    schema_version: u32,
    pub notice_version: u64,
    published_at: String,
    items: Vec<NoticeItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NoticeItem {
    id: String,
    caption: String,
    image: NoticeImage,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoticeImage {
    media_type: String,
    base64: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cache {
    manifest: Manifest,
    content_base64: String,
}

fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    if manifest.schema_version != 1
        || !(1..=9_999_999_999).contains(&manifest.notice_version)
        || manifest.published_at.len() > 64
        || manifest.sha256.len() != 64
        || manifest.signature.len() > 128
        || manifest.signing_algorithm != "ed25519"
        || manifest.key_id != "catalog-2026-01"
        || manifest.content_path != format!("/api/v1/notices/content/{}", manifest.notice_version)
    {
        return Err("Invalid notice manifest".into());
    }
    Ok(())
}

fn verify_content(
    manifest: &Manifest,
    bytes: &[u8],
    key: &VerifyingKey,
) -> Result<NoticeContent, String> {
    validate_manifest(manifest)?;
    if bytes.len() > MAX_CONTENT_BYTES || format!("{:x}", Sha256::digest(bytes)) != manifest.sha256
    {
        return Err("Notice size or digest mismatch".into());
    }
    let signature_bytes = general_purpose::STANDARD
        .decode(&manifest.signature)
        .map_err(|e| e.to_string())?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|e| e.to_string())?;
    key.verify(bytes, &signature)
        .map_err(|_| "Invalid notice signature".to_owned())?;
    let content: NoticeContent = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if content.schema_version != 1
        || content.notice_version != manifest.notice_version
        || content.published_at != manifest.published_at
        || content.items.len() > 20
    {
        return Err("Invalid notice content".into());
    }
    let mut ids = HashSet::new();
    for item in &content.items {
        if item.id.is_empty()
            || item.id.len() > 100
            || !item
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            || !ids.insert(&item.id)
            || item.caption.trim().is_empty()
            || item.caption.chars().count() > 500
            || item.image.base64.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4
        {
            return Err("Invalid notice item".into());
        }
        let image = general_purpose::STANDARD
            .decode(&item.image.base64)
            .map_err(|e| e.to_string())?;
        let valid_header = match item.image.media_type.as_str() {
            "image/jpeg" => image.starts_with(&[0xff, 0xd8, 0xff]),
            "image/png" => image.starts_with(b"\x89PNG\r\n\x1a\n"),
            _ => false,
        };
        if !valid_header || image.len() > MAX_IMAGE_BYTES {
            return Err("Invalid notice image".into());
        }
    }
    Ok(content)
}

fn read_cache(path: &Path) -> Result<NoticeContent, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(12 * 1024 * 1024 + 1).read_to_end(&mut bytes))
        .map_err(|e| e.to_string())?;
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("Notice cache too large".into());
    }
    let cache: Cache = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let content = general_purpose::STANDARD
        .decode(&cache.content_base64)
        .map_err(|e| e.to_string())?;
    verify_content(&cache.manifest, &content, &catalog::production_key()?)
}

pub fn load_cached(data_dir: &Path) -> Result<Option<NoticeContent>, String> {
    let primary = data_dir.join(CACHE_FILE);
    let backup = primary.with_extension("json.backup");
    if primary.is_file() {
        match read_cache(&primary) {
            Ok(content) => return Ok(Some(content)),
            Err(_) if backup.is_file() => return read_cache(&backup).map(Some),
            Err(error) => return Err(error),
        }
    }
    if backup.is_file() {
        return read_cache(&backup).map(Some);
    }
    Ok(None)
}

pub fn check_for_update(data_dir: &Path) -> Result<Option<NoticeContent>, String> {
    let current = load_cached(data_dir)
        .ok()
        .flatten()
        .map_or(0, |content| content.notice_version);
    let bytes = network::fetch_https(HOST, MANIFEST_PATH, "application/json", 16 * 1024)?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    validate_manifest(&manifest)?;
    if manifest.notice_version <= current {
        return Ok(None);
    }
    let content_bytes = network::fetch_https(
        HOST,
        &manifest.content_path,
        "application/json",
        MAX_CONTENT_BYTES,
    )?;
    let content = verify_content(&manifest, &content_bytes, &catalog::production_key()?)?;
    let cache = Cache {
        manifest,
        content_base64: general_purpose::STANDARD.encode(&content_bytes),
    };
    config::atomic_write(
        &data_dir.join(CACHE_FILE),
        &serde_json::to_vec(&cache).map_err(|e| e.to_string())?,
        true,
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(content))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    fn bundle(items: serde_json::Value) -> (Manifest, Vec<u8>, SigningKey) {
        let key = SigningKey::from_bytes(&[42; 32]);
        let bytes = serde_json::to_vec(
            &json!({"schemaVersion":1,"noticeVersion":2,"publishedAt":"2026-09-23","items":items}),
        )
        .unwrap();
        let manifest = Manifest {
            schema_version: 1,
            notice_version: 2,
            published_at: "2026-09-23".into(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            signature: general_purpose::STANDARD.encode(key.sign(&bytes).to_bytes()),
            signing_algorithm: "ed25519".into(),
            key_id: "catalog-2026-01".into(),
            content_path: "/api/v1/notices/content/2".into(),
        };
        (manifest, bytes, key)
    }

    #[test]
    fn validates_signed_notices_and_rejects_tampering() {
        let (manifest, mut bytes, key) = bundle(json!([]));
        assert_eq!(
            verify_content(&manifest, &bytes, &key.verifying_key())
                .unwrap()
                .notice_version,
            2
        );
        bytes.push(b' ');
        assert!(verify_content(&manifest, &bytes, &key.verifying_key()).is_err());
        let (mut manifest, bytes, _) = bundle(json!([]));
        manifest.content_path = "https://other.invalid/content".into();
        assert!(verify_content(&manifest, &bytes, &key.verifying_key()).is_err());
    }

    #[test]
    fn rejects_unsafe_images_and_oversized_captions() {
        let item = json!({"id":"listing","caption":"listing", "image":{"mediaType":"image/svg+xml","base64":general_purpose::STANDARD.encode(b"<svg/>")}});
        let (manifest, bytes, key) = bundle(json!([item]));
        assert!(verify_content(&manifest, &bytes, &key.verifying_key()).is_err());
        let item = json!({"id":"listing","caption":"x".repeat(501), "image":{"mediaType":"image/jpeg","base64":general_purpose::STANDARD.encode([0xff,0xd8,0xff])}});
        let (manifest, bytes, key) = bundle(json!([item]));
        assert!(verify_content(&manifest, &bytes, &key.verifying_key()).is_err());
    }
}
