use crate::error::{HostError, HostResult};
use std::net::IpAddr;
use url::{Host, Url};

const MAX_EXTERNAL_URL_BYTES: usize = 2_048;
const MAX_DEEP_LINK_BYTES: usize = 8_192;

pub fn normalize_external_url(raw: &str) -> HostResult<String> {
    if raw.is_empty()
        || raw.len() > MAX_EXTERNAL_URL_BYTES
        || raw.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(HostError::invalid("External URL is invalid"));
    }
    let mut url = Url::parse(raw).map_err(|_| HostError::invalid("External URL is invalid"))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(HostError::invalid(
            "Only HTTP and HTTPS links may be opened",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(HostError::invalid(
            "Credential-bearing links are not allowed",
        ));
    }
    match url.host() {
        Some(Host::Domain(domain)) if !is_local_domain(domain) => {}
        Some(Host::Ipv4(address)) if is_public_ip(IpAddr::V4(address)) => {}
        Some(Host::Ipv6(address)) if is_public_ip(IpAddr::V6(address)) => {}
        _ => {
            return Err(HostError::invalid(
                "Local, private, and malformed link destinations are not allowed",
            ))
        }
    }
    // Fragments never reach the remote server and may contain copied secret
    // material. Discard them before handing the URL to the operating system.
    url.set_fragment(None);
    Ok(url.to_string())
}

pub fn normalize_deep_link(raw: &str) -> HostResult<String> {
    if raw.is_empty()
        || raw.len() > MAX_DEEP_LINK_BYTES
        || raw.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(HostError::invalid("Deep link is invalid"));
    }
    let url = Url::parse(raw).map_err(|_| HostError::invalid("Deep link is invalid"))?;
    if url.scheme() != "cupcake" || !url.username().is_empty() || url.password().is_some() {
        return Err(HostError::invalid("Deep link is not a CupcakeAI link"));
    }
    // Keep deep links product-owned. File URLs, embedded network destinations,
    // and opaque paths are never reinterpreted by the host.
    if url.cannot_be_a_base() || url.host_str().is_none() {
        return Err(HostError::invalid("Deep link route is missing"));
    }
    Ok(url.to_string())
}

/// Top-level webview navigation is confined to the compiled application
/// origin (and the fixed Vite loopback origin in debug builds). External URLs
/// must cross the separate `open_external_url` command and policy above.
pub fn allow_webview_navigation(url: &Url) -> bool {
    let production_origin = matches!(url.scheme(), "tauri" | "https")
        && matches!(url.host_str(), Some("localhost" | "tauri.localhost"));
    let development_origin = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(42619);
    production_origin || development_origin
}

fn is_local_domain(domain: &str) -> bool {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    domain == "localhost"
        || domain.ends_with(".localhost")
        || domain.ends_with(".local")
        || domain.ends_with(".internal")
        || !domain.contains('.')
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast())
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            let unique_local = first & 0xfe00 == 0xfc00;
            let link_local = first & 0xffc0 == 0xfe80;
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || unique_local
                || link_local)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_public_https_and_removes_fragments() {
        assert_eq!(
            normalize_external_url("https://platform.openai.com/docs/#api-keys").unwrap(),
            "https://platform.openai.com/docs/"
        );
    }

    #[test]
    fn rejects_local_executable_and_credential_destinations() {
        for value in [
            "file:///C:/Windows/System32/cmd.exe",
            "https://localhost:9000/",
            "http://127.0.0.1/",
            "https://user:secret@example.com/",
            "javascript:alert(1)",
            "https://intranet/",
        ] {
            assert!(normalize_external_url(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn accepts_only_routed_product_deep_links() {
        assert!(normalize_deep_link("cupcake://chat/0198f1e2").is_ok());
        assert!(normalize_deep_link("https://example.com/").is_err());
        assert!(normalize_deep_link("cupcake:opaque").is_err());
    }

    #[test]
    fn webview_navigation_never_accepts_public_or_file_urls() {
        assert!(allow_webview_navigation(
            &Url::parse("https://tauri.localhost/index.html").unwrap()
        ));
        assert!(!allow_webview_navigation(
            &Url::parse("https://example.com/").unwrap()
        ));
        assert!(!allow_webview_navigation(
            &Url::parse("file:///C:/Users/example/secrets.txt").unwrap()
        ));
    }
}
