//! Windows process-tree containment for the broker and every child it creates.

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct ProcessJob(HANDLE);

    // A job handle is an owned kernel handle. Windows permits it to be closed
    // from any thread, while this host moves it only as part of its connection.
    unsafe impl Send for ProcessJob {}

    impl ProcessJob {
        pub fn contain(child: &Child) -> std::io::Result<Self> {
            // SAFETY: Null security/name pointers request a private unnamed job.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: The structure is plain old data and its length exactly
            // matches the JobObjectExtendedLimitInformation contract.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast::<c_void>(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                // SAFETY: `handle` is live and owned here.
                unsafe { CloseHandle(handle) };
                return Err(std::io::Error::last_os_error());
            }
            let process = child.as_raw_handle() as HANDLE;
            // SAFETY: Both handles are live for the duration of the call.
            if unsafe { AssignProcessToJobObject(handle, process) } == 0 {
                // SAFETY: `handle` is live and owned here.
                unsafe { CloseHandle(handle) };
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self(handle))
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            // SAFETY: The tuple owns this non-null handle exactly once. Closing
            // it invokes KILL_ON_JOB_CLOSE for the entire broker process tree.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub use ProcessJob as Job;
}

#[cfg(windows)]
pub use windows_job::Job as ProcessJob;

#[cfg(not(windows))]
pub struct ProcessJob;

#[cfg(not(windows))]
impl ProcessJob {
    pub fn contain(_: &std::process::Child) -> std::io::Result<Self> {
        Ok(Self)
    }
}
