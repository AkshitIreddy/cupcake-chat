use crate::{BrokerError, Result};
use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;
use url::Url;

const MAX_REDIRECTS: usize = 3;
const USER_AGENT_VALUE: &str = "CupcakeAI/2.0-rc (+local desktop; bounded fetch)";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpsResponse {
    pub final_url: String,
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

pub trait HttpsBackend: Send + Sync {
    fn fetch(&self, url: &Url, timeout_ms: u64, maximum: usize) -> Result<HttpsResponse>;
    fn search(&self, query: &str, timeout_ms: u64, maximum: usize) -> Result<HttpsResponse>;
    fn search_origin(&self) -> Option<String>;
}

/// Blocking HTTPS backend for the broker process. Every hop is separately
/// resolved, checked against non-public address ranges, then pinned into a new
/// client. Redirects cannot use reqwest's implicit resolver and DNS rebinding
/// cannot change the address after validation.
#[derive(Debug, Clone)]
pub struct StrictHttpsClient {
    search_endpoint: Option<Url>,
}

impl StrictHttpsClient {
    pub fn new(search_endpoint: Option<Url>) -> Result<Self> {
        if let Some(endpoint) = &search_endpoint {
            validate_public_https_url(endpoint)?;
            if endpoint.query().is_some() || endpoint.fragment().is_some() {
                return Err(BrokerError::InvalidConfig(
                    "search endpoint must not contain query or fragment data".into(),
                ));
            }
        }
        Ok(Self { search_endpoint })
    }
}

impl HttpsBackend for StrictHttpsClient {
    fn fetch(&self, url: &Url, timeout_ms: u64, maximum: usize) -> Result<HttpsResponse> {
        fetch_pinned(url.clone(), timeout_ms, maximum)
    }

    fn search(&self, query: &str, timeout_ms: u64, maximum: usize) -> Result<HttpsResponse> {
        if query.trim().is_empty() || query.len() > 2_048 || query.contains('\0') {
            return Err(BrokerError::InvalidConfig(
                "invalid web search query".into(),
            ));
        }
        let mut endpoint = self.search_endpoint.clone().ok_or_else(|| {
            BrokerError::InvalidConfig("no broker-approved search endpoint is configured".into())
        })?;
        endpoint.query_pairs_mut().append_pair("q", query.trim());
        fetch_pinned(endpoint, timeout_ms, maximum)
    }

    fn search_origin(&self) -> Option<String> {
        self.search_endpoint
            .as_ref()
            .map(|url| format!("{}://{}", url.scheme(), url.host_str().unwrap_or("invalid")))
    }
}

pub fn validate_public_https_url(url: &Url) -> Result<()> {
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
        || !matches!(url.port(), None | Some(443))
    {
        return Err(BrokerError::PermissionDenied(
            "only credential-free public HTTPS URLs on port 443 are allowed".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| BrokerError::InvalidConfig("HTTPS URL must contain a hostname".into()))?;
    let normalized_host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    if host.ends_with('.')
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host.to_ascii_lowercase().ends_with(".local")
        || host.to_ascii_lowercase().ends_with(".internal")
        || host.contains('%')
    {
        return Err(BrokerError::PermissionDenied(
            "local, internal, and zone-scoped hosts are denied".into(),
        ));
    }
    if let Ok(address) = normalized_host.parse::<IpAddr>() {
        validate_public_ip(address)?;
    }
    Ok(())
}

pub fn validate_public_ip(address: IpAddr) -> Result<()> {
    let public = match address {
        IpAddr::V4(value) => is_public_v4(value),
        IpAddr::V6(value) => value
            .to_ipv4()
            .map(is_public_v4)
            .unwrap_or_else(|| is_public_v6(value)),
    };
    if public {
        Ok(())
    } else {
        Err(BrokerError::PermissionDenied(
            "private, local, reserved, and non-routable network addresses are denied".into(),
        ))
    }
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_unspecified()
        || address.is_multicast()
        || octets[0] == 0
        || octets[0] >= 240
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 198 && matches!(octets[1], 18 | 19)))
}

fn is_public_v6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    !(address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2..6] == [0, 0, 0, 0])
        || segments[0] == 0x2002
        || (segments[0] == 0x2001 && matches!(segments[1], 0x0000 | 0x0db8)))
}

fn fetch_pinned(mut url: Url, timeout_ms: u64, maximum: usize) -> Result<HttpsResponse> {
    if timeout_ms == 0 || maximum == 0 {
        return Err(BrokerError::InvalidConfig(
            "network timeout and output bound must be positive".into(),
        ));
    }
    for redirect in 0..=MAX_REDIRECTS {
        validate_public_https_url(&url)?;
        let host = url.host_str().ok_or_else(|| {
            BrokerError::InvalidConfig("HTTPS URL must contain a hostname".into())
        })?;
        let normalized_host = host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(host);
        let addresses = resolve_public_addresses(normalized_host)?;
        let client = pinned_client(normalized_host, &addresses, timeout_ms)?;
        let response = client
            .get(url.clone())
            .header(USER_AGENT, USER_AGENT_VALUE)
            .header(
                ACCEPT,
                "text/html,application/json,text/plain;q=0.9,*/*;q=0.1",
            )
            .send()
            .map_err(redacted_network_error)?;
        if response.status().is_redirection() {
            if redirect == MAX_REDIRECTS {
                return Err(BrokerError::PermissionDenied(
                    "HTTPS redirect limit exceeded".into(),
                ));
            }
            let location = response.headers().get(LOCATION).ok_or_else(|| {
                BrokerError::InvalidConfig("redirect omitted its location".into())
            })?;
            let location = location.to_str().map_err(|_| {
                BrokerError::InvalidConfig("redirect location is not valid text".into())
            })?;
            url = url.join(location)?;
            continue;
        }
        return consume_bounded(response, url, maximum);
    }
    Err(BrokerError::PermissionDenied(
        "HTTPS redirect limit exceeded".into(),
    ))
}

fn resolve_public_addresses(host: &str) -> Result<Vec<SocketAddr>> {
    let mut addresses = (host, 443)
        .to_socket_addrs()
        .map_err(|_| BrokerError::PermissionDenied("HTTPS hostname could not be resolved".into()))?
        .collect::<Vec<_>>();
    addresses.sort();
    addresses.dedup();
    if addresses.is_empty() || addresses.len() > 32 {
        return Err(BrokerError::PermissionDenied(
            "HTTPS hostname returned an invalid address set".into(),
        ));
    }
    for address in &addresses {
        validate_public_ip(address.ip())?;
    }
    Ok(addresses)
}

fn pinned_client(host: &str, addresses: &[SocketAddr], timeout_ms: u64) -> Result<Client> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_millis(timeout_ms))
        .connect_timeout(Duration::from_millis(timeout_ms.min(10_000)))
        .resolve_to_addrs(host, addresses)
        .build()
        .map_err(redacted_network_error)
}

fn consume_bounded(mut response: Response, url: Url, maximum: usize) -> Result<HttpsResponse> {
    if let Some(length) = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length > maximum as u64 {
            return Err(BrokerError::InvalidConfig(
                "HTTPS response exceeds the output bound".into(),
            ));
        }
    }
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    let mut body = Vec::new();
    response
        .by_ref()
        .take(maximum as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| {
            BrokerError::PermissionDenied("HTTPS response body could not be read".into())
        })?;
    if body.len() > maximum {
        return Err(BrokerError::InvalidConfig(
            "HTTPS response exceeds the output bound".into(),
        ));
    }
    Ok(HttpsResponse {
        final_url: redacted_url(&url),
        status,
        content_type,
        body,
    })
}

fn redacted_url(url: &Url) -> String {
    let mut redacted = url.clone();
    redacted.set_query(None);
    redacted.set_fragment(None);
    redacted.to_string()
}

fn redacted_network_error(_error: reqwest::Error) -> BrokerError {
    BrokerError::PermissionDenied("bounded HTTPS request failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ssrf_url_forms_before_dns_or_io() {
        for candidate in [
            "http://example.com/",
            "https://user:secret@example.com/",
            "https://localhost/",
            "https://metadata.google.internal/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://example.com:8443/",
            "https://example.com/#secret",
        ] {
            assert!(
                validate_public_https_url(&Url::parse(candidate).unwrap()).is_err(),
                "{candidate}"
            );
        }
        assert!(
            validate_public_https_url(&Url::parse("https://example.com/path?q=ok").unwrap())
                .is_ok()
        );
    }

    #[test]
    fn rejects_reserved_and_private_address_ranges() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::",
            "2001::1",
        ] {
            assert!(
                validate_public_ip(address.parse().unwrap()).is_err(),
                "{address}"
            );
        }
        assert!(validate_public_ip("1.1.1.1".parse().unwrap()).is_ok());
        assert!(validate_public_ip("2606:4700:4700::1111".parse().unwrap()).is_ok());
    }
}
