# Google Workspace

Settings → Integrations → Google Workspace connects a user-owned **Desktop app**
OAuth client. This integration provides native API operations for Docs, Sheets,
Slides, Forms and Calendar. It is an API editing workbench, not an embedded copy
of Google's complete web editors. It currently runs in the desktop host; the
standalone headless server must explicitly add these commands before offering
them remotely.

## Configure your client

1. Create or select a project in Google Cloud Console.
2. Enable the Google Docs, Sheets, Slides, Forms, Calendar and Drive APIs for the
   products you intend to use. Drive is used to list app-accessible files and
   export PDFs.
3. Configure the OAuth consent screen. If its publishing status is Testing, add
   your Google account as a test user. Your organization may require administrator
   approval. Testing-mode refresh tokens may have a limited lifetime.
4. Create an OAuth client of type **Desktop app**. Copy its client ID into
   Lattice. A client secret can also be supplied if your client requires one;
   Google documents it as optional for this flow. Do not use a Web application
   client or another application's credentials.
5. Select only the products you need, then choose **Sign in with default browser**.
   Review Google's consent screen and approve the requested permissions there.
   Lattice never asks for your Google password.

The system browser returns an authorization code to a random loopback port on
`127.0.0.1`. The host validates the callback path, Host header and random state,
then exchanges the code with its PKCE S256 verifier. The callback is local to
the desktop running Lattice; it does not work by redirecting a remote phone to
a server's loopback address. Pending sign-in can be cancelled. An unsuccessful
or cancelled attempt preserves an existing account.

Google does not issue a generic OAuth client for arbitrary open-source clones.
Without a client ID and actual consent, the integration cannot be considered
connected. Browser cookies or credentials from another application are never
imported.

## Operations

| Product | Supported operations |
| --- | --- |
| Docs | Read document JSON, create a titled document, apply `documents.batchUpdate` requests, export PDF |
| Sheets | Read an A1 range, create a spreadsheet, write a values array using `RAW`, export PDF |
| Slides | Read presentation JSON, create a presentation, apply `presentations.batchUpdate` requests, export PDF |
| Forms | Read a form, create a titled form, apply `forms.batchUpdate` requests, read the first page of responses |
| Calendar | List owned calendars, list/read events, create and patch private events |

The panel starts with editable request examples. New resources populate their
ID field automatically. Apply update sends the displayed JSON only when clicked;
it does not autosave raw API edits. Read results appear as escaped JSON and are
not saved in browser storage. IDs can be copied from Google's resource URLs.

Calendar uses `primary` by default. Leave Event ID blank to list events; fill it
to read or patch one. Calendar writes accept summary, description, location,
start/end, status, transparency, visibility, color and reminders. Attendees,
invitations and conference provisioning are deliberately rejected, and writes
set `sendUpdates=none`.
Writes force private visibility. Before updating, the host reads the current
event, rejects meetings with attendees, and uses its ETag in `If-Match` so a
concurrent change cannot bypass that check. Use Google's full Calendar editor
for meetings and invitations.

File listing uses Drive's `drive.file` scope, so it lists files created or
authorized for this app, not every file in your Drive. Reading an existing
resource by ID additionally uses the selected product's scope and the account's
actual access. PDF export also requires Drive access to that file. The first
page contains at most 100 listed resources/events/responses. Pagination tokens
are visible in API results; automatic pagination is not implemented in this
initial workbench. Responses are bounded to 20 MiB and request bodies to 1 MiB.

**Open in Google** opens the resource's full editor in the default browser. The
browser may have a different Google account selected; use Google's account
switcher there when needed. This does not copy Lattice's tokens into a URL or
attempt to share browser cookies.

## Permissions and credentials

The consent request always includes `openid`, `email` and `drive.file`. Selecting
a product additionally requests:

| Selection | Google scopes |
| --- | --- |
| Docs | `documents` |
| Sheets | `spreadsheets` |
| Slides | `presentations` |
| Forms | `forms.body`, `forms.responses.readonly` |
| Calendar | `calendar.events.owned`, `calendar.calendarlist.readonly` |

Scope names above use the `https://www.googleapis.com/auth/` prefix. Product
scopes permit access beyond app-created resources, so approve only products
you intend to use. If Google grants only part of the request, unavailable
operations fail before contacting their API. Reconnect to change permissions.

Access and refresh tokens stay in the native host's app-config
`google-workspace.json`, written atomically with mode `0600` on Unix. The client
configuration and optional client secret are in that same private file after a
successful authorization. Tokens are never returned by IPC, placed in URLs,
localStorage, the clipboard or error logs. Refresh replaces the access token only
after a successful response; a provider failure preserves the saved refresh
token. Disconnect clears local credentials and attempts server-side revocation;
you can also remove the app's access in your Google Account permissions page.

## Contributor verification

The Rust fixture server exercises all five products through the actual API
consumer, authorization headers, refresh, provider rejection, scope refusal,
private storage, PKCE and callback guards. React consumer tests exercise explicit
configuration, create/read/update, redacted failures and stale-result disposal.
These tests use fake accounts and do not modify Google data. Live authorization
still requires a configured client and the user's direct consent.

Protocol references:
[Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Docs batchUpdate](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate),
[Sheets values update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update),
[Slides batchUpdate](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/batchUpdate),
[Forms API](https://developers.google.com/workspace/forms/api/reference/rest),
[Calendar events](https://developers.google.com/workspace/calendar/api/v3/reference/events),
[Calendar resource versions](https://developers.google.com/workspace/calendar/api/guides/version-resources),
[Drive export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export).
