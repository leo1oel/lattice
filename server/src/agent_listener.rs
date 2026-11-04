//! Agent documents live on an independent origin; this listener has no host IPC.
use crate::transport::Server;
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Router,
};
use std::net::SocketAddr;
pub fn origin(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid public origin".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Public origins must contain only scheme, host and port".into());
    }
    Ok(url.origin().ascii_serialization())
}
pub async fn bind(address: SocketAddr) -> Result<tokio::net::TcpListener, String> {
    if !address.ip().is_loopback() {
        return Err("Agent listener must bind loopback".into());
    }
    tokio::net::TcpListener::bind(address).await.map_err(|e| e.to_string())
}
pub fn authorize(state: &Server, headers: &HeaderMap) -> Result<(), Response> {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if origin.is_some_and(|origin| origin != state.agent_origin) {
        return Err(crate::server_session::failure(
            StatusCode::FORBIDDEN,
            "origin_forbidden",
            "Only the configured agent origin may use this endpoint.",
        ));
    }
    if origin.is_none() && headers.get("upgrade").is_some() {
        return Err(crate::server_session::failure(
            StatusCode::FORBIDDEN,
            "origin_forbidden",
            "WebSockets require the configured agent origin.",
        ));
    }
    if !crate::server_session::authenticated(state, headers) {
        return Err(crate::server_session::failure(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Sign in through the main application.",
        ));
    }
    Ok(())
}
pub fn router(state: Server) -> Router {
    crate::agent_transport::routes().with_state(state)
}
