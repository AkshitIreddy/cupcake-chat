//! Safe adapter between `std::process::Child` and the broker's Windows Job.
//!
//! `Command` creates the child suspended. We assign its process handle to the
//! already configured kill-on-close Job, locate the still-suspended primary
//! thread, and only then resume it. This closes the descendant escape race
//! that exists when a running child is assigned after `spawn`.

use crate::registry::ResourceLimits;
use crate::sandbox::WindowsJob;
use crate::{BrokerError, Result};
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsHandle;
use std::process::Child;
use std::sync::Arc;
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

pub const CREATE_SUSPENDED_FLAG: u32 = 0x0000_0004;
const CONTAINMENT_FAILURE_EXIT_CODE: u32 = 0xC0C0_0002;

pub fn assign_and_resume(
    child: &mut Child,
    limits: &ResourceLimits,
    process_limit: u32,
) -> Result<Arc<WindowsJob>> {
    let job = Arc::new(WindowsJob::new(limits, process_limit)?);
    if let Err(error) = job.assign(child.as_handle()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    if let Err(error) = resume_suspended_process(child.id()) {
        let _ = job.terminate(CONTAINMENT_FAILURE_EXIT_CODE);
        let _ = child.wait();
        return Err(error);
    }
    Ok(job)
}

fn resume_suspended_process(process_id: u32) -> Result<()> {
    // SAFETY: the snapshot and every opened thread handle are closed on all
    // paths. THREADENTRY32.dwSize is initialized per ToolHelp's contract.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut entry: THREADENTRY32 = zeroed();
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut found = false;
        let mut has_entry = Thread32First(snapshot, &mut entry) != 0;
        while has_entry {
            if entry.th32OwnerProcessID == process_id {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    let result = ResumeThread(thread);
                    let _ = CloseHandle(thread);
                    if result != u32::MAX {
                        found = true;
                    }
                }
            }
            has_entry = Thread32Next(snapshot, &mut entry) != 0;
        }
        let _ = CloseHandle(snapshot);
        if !found {
            return Err(BrokerError::SandboxUnavailable(
                "contained child primary thread could not be resumed".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    #[test]
    fn suspended_child_is_assigned_before_it_runs() {
        let system_root = std::env::var_os("SYSTEMROOT").expect("Windows SYSTEMROOT");
        let executable = std::path::PathBuf::from(system_root)
            .join("System32")
            .join("where.exe");
        let mut child = Command::new(executable)
            .arg("where.exe")
            .creation_flags(CREATE_SUSPENDED_FLAG | 0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let job = assign_and_resume(&mut child, &ResourceLimits::default(), 2).unwrap();
        assert!(child.wait().unwrap().success());
        drop(job);
    }
}
