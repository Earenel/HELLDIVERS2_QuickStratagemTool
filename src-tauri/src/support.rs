use crate::config;
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path};

const STATE_FILE: &str = "support-state.json";
const MAX_STATE_BYTES: u64 = 4096;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct UsageState {
    launch_count: u32,
    star_reminder_dismissed: bool,
}

#[derive(Default)]
pub struct StartupUsage {
    registration_attempted: bool,
    state: Option<UsageState>,
}

impl StartupUsage {
    /// The process owns this state: a renderer reload or a second IPC call
    /// cannot count another launch or show the same reminder twice.
    pub fn take_reminder(&mut self, data_dir: &Path) -> Result<Option<u32>, String> {
        if self.registration_attempted {
            return Ok(None);
        }
        self.registration_attempted = true;
        let mut state = load_state(data_dir)?;
        state.launch_count = state.launch_count.saturating_add(1);
        save_state(data_dir, &state)?;
        let reminder = (!state.star_reminder_dismissed
            && matches!(state.launch_count, 10 | 20 | 50))
        .then_some(state.launch_count);
        self.state = Some(state);
        Ok(reminder)
    }

    pub fn dismiss(&mut self, data_dir: &Path) -> Result<(), String> {
        let mut state = match &self.state {
            Some(state) => state.clone(),
            None => load_state(data_dir)?,
        };
        state.star_reminder_dismissed = true;
        // Report success only after the choice is durably saved. The UI can
        // stay open and offer a retry if storage is unavailable.
        save_state(data_dir, &state)?;
        self.state = Some(state);
        Ok(())
    }
}

fn read_state(path: &Path) -> Result<UsageState, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_STATE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("Cannot read usage state: {error}"))?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Usage state is too large".to_owned());
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("Invalid usage state: {error}"))
}

fn load_state(data_dir: &Path) -> Result<UsageState, String> {
    let primary = data_dir.join(STATE_FILE);
    let pending = primary.with_extension("json.pending");
    let backup = primary.with_extension("json.backup");
    let mut last_error = None;
    for path in [&primary, &pending, &backup] {
        match path.try_exists() {
            Ok(false) => continue,
            Err(error) => return Err(format!("Cannot inspect usage state: {error}")),
            Ok(true) => {}
        }
        match read_state(path) {
            Ok(state) => return Ok(state),
            Err(error) => last_error = Some(error),
        }
    }
    // Corruption must not reset an existing opt-out or restart the reminders.
    match last_error {
        Some(error) => Err(error),
        None => Ok(UsageState::default()),
    }
}

fn save_state(data_dir: &Path, state: &UsageState) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(state).map_err(|error| format!("Cannot encode usage state: {error}"))?;
    config::atomic_write(&data_dir.join(STATE_FILE), &bytes, true)
        .map_err(|error| format!("Cannot save usage state: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("hd2-support-{}-{unique}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reminds_only_on_milestones_and_counts_once_per_process() {
        let dir = TestDirectory::new();
        let mut reminders = Vec::new();
        for expected in 1..=60 {
            let mut usage = StartupUsage::default();
            if let Some(count) = usage.take_reminder(&dir.0).unwrap() {
                reminders.push(count);
            }
            assert_eq!(usage.take_reminder(&dir.0).unwrap(), None);
            assert_eq!(load_state(&dir.0).unwrap().launch_count, expected);
        }
        assert_eq!(reminders, [10, 20, 50]);
    }

    #[test]
    fn opt_out_survives_restarts_and_settings_saves() {
        let dir = TestDirectory::new();
        save_state(
            &dir.0,
            &UsageState {
                launch_count: 9,
                ..UsageState::default()
            },
        )
        .unwrap();
        let mut usage = StartupUsage::default();
        assert_eq!(usage.take_reminder(&dir.0).unwrap(), Some(10));
        usage.dismiss(&dir.0).unwrap();
        config::save_json(
            &dir.0,
            "settings.json",
            &serde_json::json!({ "language": "en" }),
        )
        .unwrap();
        for _ in 11..=60 {
            assert_eq!(StartupUsage::default().take_reminder(&dir.0).unwrap(), None);
        }
        assert!(load_state(&dir.0).unwrap().star_reminder_dismissed);
    }

    #[test]
    fn recovers_saved_opt_out_and_rejects_unrecoverable_state() {
        let dir = TestDirectory::new();
        let state = UsageState {
            launch_count: 49,
            star_reminder_dismissed: true,
        };
        save_state(&dir.0, &state).unwrap();
        save_state(&dir.0, &state).unwrap();
        fs::write(dir.0.join(STATE_FILE), b"broken").unwrap();
        assert_eq!(StartupUsage::default().take_reminder(&dir.0).unwrap(), None);
        assert!(load_state(&dir.0).unwrap().star_reminder_dismissed);

        let corrupt = TestDirectory::new();
        fs::write(
            corrupt.0.join(STATE_FILE),
            b"{\"starReminderDismissed\":\"false\"}",
        )
        .unwrap();
        assert!(StartupUsage::default().take_reminder(&corrupt.0).is_err());
        fs::write(
            corrupt.0.join(STATE_FILE),
            vec![b' '; MAX_STATE_BYTES as usize + 1],
        )
        .unwrap();
        assert!(StartupUsage::default().take_reminder(&corrupt.0).is_err());
    }

    #[test]
    fn failed_save_does_not_claim_success_and_can_retry_opt_out() {
        let dir = TestDirectory::new();
        save_state(
            &dir.0,
            &UsageState {
                launch_count: 9,
                ..UsageState::default()
            },
        )
        .unwrap();
        let mut usage = StartupUsage::default();
        assert_eq!(usage.take_reminder(&dir.0).unwrap(), Some(10));
        let pending = dir.0.join(STATE_FILE).with_extension("json.pending");
        fs::create_dir(&pending).unwrap();
        assert!(usage.dismiss(&dir.0).is_err());
        assert!(!load_state(&dir.0).unwrap().star_reminder_dismissed);
        fs::remove_dir(pending).unwrap();
        usage.dismiss(&dir.0).unwrap();
        assert!(load_state(&dir.0).unwrap().star_reminder_dismissed);
    }

    #[test]
    fn pending_first_write_and_counter_overflow_are_safe() {
        let dir = TestDirectory::new();
        let pending = dir.0.join(STATE_FILE).with_extension("json.pending");
        fs::write(&pending, br#"{"launchCount":19}"#).unwrap();
        assert_eq!(
            StartupUsage::default().take_reminder(&dir.0).unwrap(),
            Some(20)
        );
        save_state(
            &dir.0,
            &UsageState {
                launch_count: u32::MAX,
                ..UsageState::default()
            },
        )
        .unwrap();
        assert_eq!(StartupUsage::default().take_reminder(&dir.0).unwrap(), None);
        assert_eq!(load_state(&dir.0).unwrap().launch_count, u32::MAX);
    }
}
