use super::*;
use crate::overleaf::test_support::*;
use serde_json::json;

const MINE: &str = "64b000000000000000000001";
const SHARED: &str = "64b000000000000000000002";
const INVITED: &str = "64b000000000000000000003";

fn entry(id: &str, name: &str, updated: &str, access: &str) -> Value {
    json!({
        "id": id, "name": name, "lastUpdated": updated, "accessLevel": access,
        "archived": false, "trashed": false,
        "owner": { "email": "advisor@example.edu", "firstName": "Ada", "lastName": "Advisor" },
    })
}

fn blob(total: usize, projects: Vec<Value>) -> Value {
    json!({ "totalSize": total, "projects": projects })
}

/// The notification Overleaf's dashboard shows for an invitation not yet accepted.
fn invite(project_id: &str, name: &str) -> Value {
    json!({
        "_id": "n1", "key": format!("project-invite-{project_id}"),
        "templateKey": "notification_project_invite",
        "messageOpts": { "userName": "Ada", "projectName": name, "projectId": project_id, "token": "abc123" },
    })
}

fn two_projects() -> Vec<Value> {
    vec![
        entry(MINE, "My Paper", "2026-01-02T10:00:00.000Z", "owner"),
        entry(SHARED, "Shared Paper", "2026-07-01T10:00:00.000Z", "readWrite"),
    ]
}

fn dashboard(projects: Value, notifications: Value) -> Mock {
    Mock { dashboard: Some(dashboard_html(&projects, &notifications)), ..Default::default() }
}

fn ids(list: &OverleafProjectList) -> Vec<&str> {
    list.projects.iter().map(|project| project.id.as_str()).collect()
}

#[test]
fn lists_every_project_newest_first_with_owner_and_flags() {
    let server = Mock::default().serve();
    let list = list_projects(&signed_in(&server.base)).unwrap();
    // One list, newest first whoever owns it: Overleaf's own dashboard order.
    assert_eq!(ids(&list), ["proj-new", "proj-archived", "proj-old"]);
    let projects = &list.projects;
    assert_eq!(projects[0].name, "New Paper");
    assert_eq!(projects[0].access_level.as_deref(), Some("readAndWrite"));
    assert_eq!(projects[0].owner_email.as_deref(), Some("advisor@example.edu"));
    assert_eq!(projects[0].owner_name.as_deref(), Some("Ada Advisor"));
    assert!(!projects[0].archived && projects[1].archived && !projects[1].trashed);
    assert_eq!(projects[2].last_updated.as_deref(), Some("2026-01-02T10:00:00.000Z"));
    assert!(list.invites.is_empty());
    // The prefetched blob was whole, so nothing else was asked.
    assert!(server.with_method("POST").is_empty());
}

/// The reported symptom: a project someone shared is missing from the list.
/// Overleaf lists it only once the invitation is accepted, so until then it
/// is a dashboard notification, which the list now carries as an invitation.
#[test]
fn an_invitation_not_yet_accepted_comes_with_the_list() {
    let accepted_elsewhere = invite(SHARED, "Shared Paper");
    let mock = dashboard(
        blob(2, two_projects()),
        json!([invite(INVITED, "Grant Draft"), accepted_elsewhere]),
    );
    let server = mock.serve();
    let list = list_projects(&signed_in(&server.base)).unwrap();
    assert_eq!(ids(&list), [SHARED, MINE]);
    assert_eq!(list.invites.len(), 1, "an invitation for a listed project is already accepted");
    let pending = &list.invites[0];
    assert_eq!(
        (pending.project_id.as_str(), pending.project_name.as_str()),
        (INVITED, "Grant Draft")
    );
    assert_eq!(pending.inviter_name.as_deref(), Some("Ada"));
    // Overleaf's own invitation page, on the signed-in server.
    assert_eq!(pending.url, format!("{}/project/{INVITED}/invite/token/abc123", server.base));
}

#[test]
fn asks_overleafs_project_api_when_the_prefetch_is_short_or_missing() {
    let all = json!({ "totalSize": 2, "projects": two_projects() }).to_string();
    for prefetched in [blob(2, two_projects()[..1].to_vec()), Value::Null] {
        let mut mock = dashboard(prefetched, json!([]));
        mock.routes = vec![("POST", "/api/project", 200, all.clone())];
        let server = mock.serve();
        let list = list_projects(&signed_in(&server.base)).unwrap();
        assert_eq!(ids(&list), [SHARED, MINE]);
        let asked = server.with_method("POST");
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].csrf_header.as_deref(), Some(CSRF));
        assert_eq!(asked[0].json()["sort"], json!({ "by": "lastUpdated", "order": "desc" }));
    }
}

#[test]
fn reads_every_link_overleaf_hands_out() {
    let host = "https://www.overleaf.com";
    let project = |id: &str| Ok(Link::Project(id.to_string()));
    let share = |grant: &str, url: &str, hash: Option<&str>| {
        Ok(Link::Share { grant: grant.into(), url: url.into(), hash: hash.map(str::to_string) })
    };
    for (pasted, expected) in [
        (format!("https://www.overleaf.com/project/{MINE}"), project(MINE)),
        (format!("  overleaf.com/project/{MINE}/  "), project(MINE)),
        (format!("http://WWW.overleaf.com/project/{MINE}?x=1#y"), project(MINE)),
        (MINE.to_string(), Err(PastedLink::Unrecognized)),
        (
            format!("https://www.overleaf.com/project/{MINE}/invite/token/9f8e7d"),
            Ok(Link::Invite {
                project_id: MINE.into(),
                url: format!("{host}/project/{MINE}/invite/token/9f8e7d"),
            }),
        ),
        (
            "https://www.overleaf.com/read/abcdefghijkl#3f2a1b".into(),
            share(
                "/read/abcdefghijkl/grant",
                "https://www.overleaf.com/read/abcdefghijkl#3f2a1b",
                Some("#3f2a1b"),
            ),
        ),
        (
            "www.overleaf.com/8817238459qwertyuiop".into(),
            share(
                "/8817238459qwertyuiop/grant",
                "https://www.overleaf.com/8817238459qwertyuiop",
                None,
            ),
        ),
        (
            "https://latex.example.edu/project/x".into(),
            Err(PastedLink::OtherHost { host: "latex.example.edu".into() }),
        ),
        ("my thesis".into(), Err(PastedLink::Unrecognized)),
        ("https://www.overleaf.com/learn/latex".into(), Err(PastedLink::Unrecognized)),
        ("https://www.overleaf.com/read/ABCDEFGHIJKL".into(), Err(PastedLink::Unrecognized)),
        ("https://www.overleaf.com/project/not-an-id".into(), Err(PastedLink::Unrecognized)),
    ] {
        let parsed = parse_link(&pasted, host);
        assert_eq!(format!("{parsed:?}"), format!("{expected:?}"), "{pasted}");
    }
    // A self-hosted server is the host links must name, port included.
    let campus = "http://latex.example.edu:8080";
    let link = format!("http://latex.example.edu:8080/project/{MINE}");
    assert!(matches!(parse_link(&link, campus), Ok(Link::Project(id)) if id == MINE));
    let elsewhere = format!("https://www.overleaf.com/project/{MINE}");
    assert!(matches!(parse_link(&elsewhere, campus), Err(PastedLink::OtherHost { .. })));
}

fn resolve(mock: Mock, pasted: &str) -> (MockServer, PastedLink) {
    let server = mock.serve();
    let pasted = pasted.replace("{base}", &server.base);
    let answer = resolve_link(&signed_in(&server.base), &pasted).unwrap();
    (server, answer)
}

#[test]
fn a_project_link_opens_a_listed_project_or_says_why_not() {
    let listed = || dashboard(blob(2, two_projects()), json!([invite(INVITED, "Grant Draft")]));
    let (_, answer) = resolve(listed(), &format!("{{base}}/project/{SHARED}"));
    let PastedLink::Project { project } = answer else { panic!("{answer:?}") };
    assert_eq!(
        (project.name.as_str(), project.access_level.as_deref()),
        ("Shared Paper", Some("readWrite"))
    );

    let (_, answer) = resolve(listed(), &format!("{{base}}/project/{INVITED}"));
    let PastedLink::Invited { project_name, url } = answer else { panic!("{answer:?}") };
    assert_eq!(project_name.as_deref(), Some("Grant Draft"));
    assert!(url.ends_with(&format!("/project/{INVITED}/invite/token/abc123")));

    let unknown = "64b0000000000000000000ff";
    let (_, answer) = resolve(listed(), &format!("{{base}}/project/{unknown}"));
    assert!(matches!(answer, PastedLink::NoAccess), "{answer:?}");
    let (server, answer) =
        resolve(listed(), &format!("{{base}}/project/{unknown}/invite/token/feed"));
    let PastedLink::Invited { url, .. } = answer else { panic!("{answer:?}") };
    assert_eq!(url, format!("{}/project/{unknown}/invite/token/feed", server.base));
    // Nothing was accepted on the user's behalf.
    assert!(server.with_method("POST").is_empty());
}

#[test]
fn a_share_link_is_checked_the_way_overleafs_link_page_checks_it_and_never_joined() {
    let with_grant = |status: u16, body: Value| {
        let mut mock = dashboard(blob(2, two_projects()), json!([]));
        mock.routes = vec![("POST", "/read/abcdefghijkl/grant", status, body.to_string())];
        mock
    };
    let link = "{base}/read/abcdefghijkl#3f2a";
    let (server, answer) =
        resolve(with_grant(200, json!({ "requireAccept": { "projectName": "Lab Notes" } })), link);
    let PastedLink::NeedsJoin { project_name, url } = answer else { panic!("{answer:?}") };
    assert_eq!(project_name.as_deref(), Some("Lab Notes"));
    assert_eq!(url, format!("{}/read/abcdefghijkl#3f2a", server.base));
    let asked = server.with_method("POST");
    assert_eq!(asked.len(), 1, "one question, and no second post that joins");
    assert_eq!(asked[0].csrf_header.as_deref(), Some(CSRF));
    assert_eq!(asked[0].json(), json!({ "confirmedByUser": false, "tokenHashPrefix": "#3f2a" }));

    let member = json!({ "redirect": format!("/project/{SHARED}"), "higherAccess": true });
    let (_, answer) = resolve(with_grant(200, member), link);
    assert!(
        matches!(answer, PastedLink::Project { ref project } if project.id == SHARED),
        "{answer:?}"
    );
    let restricted = json!({ "redirect": "/restricted", "anonWriteAccessDenied": true });
    let (_, answer) = resolve(with_grant(200, restricted), link);
    assert!(matches!(answer, PastedLink::NoAccess), "{answer:?}");
    let (_, answer) = resolve(with_grant(404, json!({})), link);
    assert!(matches!(answer, PastedLink::NotFound), "{answer:?}");
}

#[test]
fn a_link_to_another_server_asks_nothing() {
    let (server, answer) =
        resolve(Mock::default(), &format!("https://latex.example.edu/project/{MINE}"));
    assert!(matches!(answer, PastedLink::OtherHost { ref host } if host == "latex.example.edu"));
    assert!(server.recorded().is_empty());
}
