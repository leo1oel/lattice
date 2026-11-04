use super::{
    account::{self, API_ERROR},
    GoogleState, Product,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{blocking::Client, Method};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{io::Read, path::Path};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRequest {
    pub product: Product,
    pub operation: String,
    #[serde(default)]
    pub resource_id: String,
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub range: String,
    #[serde(default)]
    pub body: Value,
}
struct Plan {
    method: Method,
    url: String,
    body: Option<Value>,
    export: bool,
}
fn segment(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err("Provide a Google resource ID.".into());
    }
    Ok(crate::util::url_encode(value))
}
fn plan(request: &WorkspaceRequest) -> Result<Plan, String> {
    let WorkspaceRequest { product, operation, resource_id, item_id, range, body } = request;
    if serde_json::to_vec(body).map_err(|_| API_ERROR.to_string())?.len() > 1024 * 1024 {
        return Err("Google request exceeds the one-megabyte limit.".into());
    }
    let collection = match product {
        Product::Docs => "https://docs.googleapis.com/v1/documents",
        Product::Sheets => "https://sheets.googleapis.com/v4/spreadsheets",
        Product::Slides => "https://slides.googleapis.com/v1/presentations",
        Product::Forms => "https://forms.googleapis.com/v1/forms",
        Product::Calendar => "https://www.googleapis.com/calendar/v3/calendars",
    };
    let calendar = if resource_id.is_empty() { "primary" } else { resource_id };
    let mut plan = Plan { method: Method::GET, url: collection.into(), body: None, export: false };
    match operation.as_str() {
        "list" => {
            if *product == Product::Calendar {
                plan.url="https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=owner&maxResults=100".into();
            } else {
                let mime = match product {
                    Product::Docs => "application/vnd.google-apps.document",
                    Product::Sheets => "application/vnd.google-apps.spreadsheet",
                    Product::Slides => "application/vnd.google-apps.presentation",
                    Product::Forms => "application/vnd.google-apps.form",
                    Product::Calendar => unreachable!(),
                };
                let query = format!("mimeType='{mime}' and trashed=false");
                let mut url = reqwest::Url::parse("https://www.googleapis.com/drive/v3/files")
                    .map_err(|_| API_ERROR.to_string())?;
                url.query_pairs_mut().extend_pairs([
                    ("q", query.as_str()),
                    ("fields", "files(id,name,webViewLink),nextPageToken"),
                    ("pageSize", "100"),
                ]);
                plan.url = url.into();
            }
        }
        "read" => {
            let id = segment(if *product == Product::Calendar { calendar } else { resource_id })?;
            plan.url = format!("{collection}/{id}");
            if *product == Product::Sheets {
                plan.url.push_str(&format!(
                    "/values/{}",
                    segment(if range.is_empty() { "A1:Z1000" } else { range })?
                ));
            }
            if *product == Product::Calendar {
                plan.url.push_str("/events");
                if !item_id.is_empty() {
                    plan.url.push_str(&format!("/{}", segment(item_id)?));
                } else {
                    plan.url.push_str("?maxResults=100&singleEvents=true&orderBy=startTime");
                }
            }
        }
        "create" => {
            plan.method = Method::POST;
            if *product == Product::Calendar {
                validate_event(body)?;
                plan.url = format!("{collection}/{}/events?sendUpdates=none", segment(calendar)?);
            } else {
                let title = body
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty() && value.len() <= 300)
                    .ok_or("Provide a title of at most 300 bytes.")?;
                plan.body = Some(match product {
                    Product::Sheets => json!({"properties":{"title":title}}),
                    Product::Forms => json!({"info":{"title":title}}),
                    _ => json!({"title":title}),
                });
            }
            if plan.body.is_none() {
                plan.body = Some(body.clone());
            }
        }
        "update" => {
            plan.method = Method::POST;
            plan.url = format!(
                "{collection}/{}:batchUpdate",
                segment(if *product == Product::Calendar { calendar } else { resource_id })?
            );
            plan.body = Some(body.clone());
            match product {
                Product::Sheets => {
                    if !body.get("values").is_some_and(Value::is_array) {
                        return Err("Sheets updates require a values array.".into());
                    }
                    plan.method = Method::PUT;
                    plan.url = format!(
                        "{collection}/{}/values/{}?valueInputOption=RAW",
                        segment(resource_id)?,
                        segment(if range.is_empty() { "A1" } else { range })?
                    );
                }
                Product::Calendar => {
                    validate_event(body)?;
                    plan.method = Method::PATCH;
                    plan.url = format!(
                        "{collection}/{}/events/{}?sendUpdates=none",
                        segment(calendar)?,
                        segment(item_id)?
                    );
                }
                _ => {
                    if !body
                        .get("requests")
                        .and_then(Value::as_array)
                        .is_some_and(|requests| !requests.is_empty() && requests.len() <= 200)
                    {
                        return Err("Provide between 1 and 200 batchUpdate requests.".into());
                    }
                }
            }
        }
        "responses" if *product == Product::Forms => {
            plan.url = format!("{collection}/{}/responses?pageSize=100", segment(resource_id)?);
        }
        "export" if matches!(product, Product::Docs | Product::Sheets | Product::Slides) => {
            plan.url = format!(
                "https://www.googleapis.com/drive/v3/files/{}/export?mimeType=application%2Fpdf",
                segment(resource_id)?
            );
            plan.export = true;
        }
        _ => return Err("This Google Workspace operation is not supported.".into()),
    }
    Ok(plan)
}
/// This panel deliberately manages private events, not invitations or conference provisioning.
fn validate_event(body: &Value) -> Result<(), String> {
    let object = body.as_object().ok_or("Provide an event object.")?;
    let fields = [
        "summary",
        "description",
        "location",
        "start",
        "end",
        "status",
        "transparency",
        "visibility",
        "colorId",
        "reminders",
    ];
    if object.is_empty() || object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err("Calendar supports private event fields only; attendees and invitations are unavailable.".into());
    }
    Ok(())
}
pub fn request(
    dir: &Path, state: &GoogleState, request: WorkspaceRequest,
) -> Result<Value, String> {
    request_using(dir, state, request, account::TOKEN_URL, None)
}
pub(super) fn request_using(
    dir: &Path, state: &GoogleState, request: WorkspaceRequest, token_url: &str,
    test_base: Option<&str>,
) -> Result<Value, String> {
    let plan = plan(&request)?;
    let credentials = account::access(dir, state, token_url)?;
    if !credentials.client.products.contains(&request.product) {
        return Err("Reconnect Google Workspace with permission for this product.".into());
    }
    let required = if request.operation == "list" && request.product != Product::Calendar
        || request.operation == "export"
    {
        "https://www.googleapis.com/auth/drive.file"
    } else {
        request.product.scopes()[0]
    };
    let required = if request.operation == "responses" {
        "https://www.googleapis.com/auth/forms.responses.readonly"
    } else if request.operation == "list" && request.product == Product::Calendar {
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
    } else {
        required
    };
    if !credentials.scopes.split_whitespace().any(|scope| scope == required) {
        return Err(
            "Google did not grant permission for this operation. Reconnect and approve its scope."
                .into(),
        );
    }
    let url = if let Some(base) = test_base {
        // Only test code calls this function with an alternate origin. No URL or endpoint is an IPC argument.
        let parsed = reqwest::Url::parse(&plan.url).map_err(|_| API_ERROR.to_string())?;
        format!(
            "{base}{}{}",
            parsed.path(),
            parsed.query().map(|query| format!("?{query}")).unwrap_or_default()
        )
    } else {
        plan.url
    };
    execute(
        &account::client()?,
        &url,
        &credentials.access_token,
        plan.method,
        plan.body,
        plan.export,
    )
}
fn execute(
    client: &Client, url: &str, token: &str, method: Method, body: Option<Value>, export: bool,
) -> Result<Value, String> {
    let mut request = client.request(method, url).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().map_err(|_| API_ERROR.to_string())?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16(){401=>"Google access expired or was revoked. Connect again.",403=>"Google denied this operation. Check the selected scopes, file access and enabled APIs.",429=>"Google rate limit reached. Try again later.",_=>API_ERROR}.into());
    }
    let mut bytes = Vec::new();
    response
        .take(20 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| API_ERROR.to_string())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Google response exceeds the twenty-megabyte limit.".into());
    }
    if export {
        return Ok(json!({"mimeType":"application/pdf","base64":STANDARD.encode(bytes)}));
    }
    serde_json::from_slice(&bytes).map_err(|_| API_ERROR.into())
}
