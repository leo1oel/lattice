use super::*;
use serde_json::Value;

const ATTENTION_MAP: &str = include_str!("../../../templates/tutorial/attention-map.tldr");
/// Made with tldraw 5.2.5 (an Editor over Lattice's board store): three pages,
/// every shape type Lattice's boards offered, bindings, a frame, a group and
/// image assets.
const MULTI_PAGE: &str = include_str!("fixtures/multi-page.tldr");

fn no_assets(_: &str) -> Option<Vec<u8>> {
    None
}

fn convert(source: &str) -> Value {
    serde_json::from_str(&convert_tldr(source, &no_assets).unwrap().to_json()).unwrap()
}

fn elements(scene: &Value) -> &Vec<Value> {
    scene["elements"].as_array().unwrap()
}

fn element<'a>(scene: &'a Value, id: &str) -> &'a Value {
    elements(scene)
        .iter()
        .find(|element| element["id"] == id)
        .unwrap_or_else(|| panic!("no element {id}"))
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

/// What Excalidraw relies on in every converted scene.
fn assert_well_formed(scene: &Value) {
    assert_eq!(scene["type"], "excalidraw");
    assert_eq!(scene["version"], 2);
    let elements = elements(scene);
    let ids: std::collections::BTreeSet<&str> =
        elements.iter().map(|element| element["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), elements.len(), "ids are unique");
    let indices: Vec<&str> =
        elements.iter().map(|element| element["index"].as_str().unwrap()).collect();
    assert!(indices.windows(2).all(|pair| pair[0] < pair[1]), "indices ascend: {indices:?}");
    for item in elements {
        assert_eq!(item["roughness"], 0., "{}", item["id"]);
        assert_eq!(item["isDeleted"], false);
        if let Some(container) = item["containerId"].as_str() {
            let bound = element_bound(scene, container);
            assert!(
                bound.contains(&(item["id"].as_str().unwrap(), "text")),
                "{container} lists its label"
            );
        }
        for key in ["startBinding", "endBinding"] {
            if let Some(target) = item[key]["elementId"].as_str() {
                assert!(
                    element_bound(scene, target).contains(&(item["id"].as_str().unwrap(), "arrow"))
                );
            }
        }
        if let Some(frame) = item["frameId"].as_str() {
            assert_eq!(element(scene, frame)["type"], "frame");
        }
    }
}

fn element_bound<'a>(scene: &'a Value, id: &str) -> Vec<(&'a str, &'a str)> {
    element(scene, id)["boundElements"]
        .as_array()
        .map(|bound| {
            bound
                .iter()
                .map(|entry| (entry["id"].as_str().unwrap(), entry["type"].as_str().unwrap()))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn empty_scene_is_an_excalidraw_file_with_no_view_state() {
    let scene: Value = serde_json::from_str(&empty_scene()).unwrap();
    assert_eq!(
        scene,
        serde_json::json!({
            "type": "excalidraw",
            "version": 2,
            "source": "lattice",
            "elements": [],
            "appState": { "gridSize": 20, "gridStep": 5, "gridModeEnabled": false, "viewBackgroundColor": "#ffffff" },
            "files": {}
        })
    );
    assert_eq!(convert_tldr("", &no_assets).unwrap().to_json(), empty_scene());
}

#[test]
fn a_file_that_is_not_a_tldraw_board_is_refused() {
    assert!(convert_tldr("not json", &no_assets).is_err());
    assert!(convert_tldr("{\"elements\": []}", &no_assets).is_err());
}

#[test]
fn converting_twice_gives_identical_bytes() {
    for source in [ATTENTION_MAP, MULTI_PAGE] {
        let first = convert_tldr(source, &no_assets).unwrap().to_json();
        assert_eq!(first, convert_tldr(source, &no_assets).unwrap().to_json());
    }
}

#[test]
fn the_tutorial_board_keeps_its_shapes_labels_and_arrows_on_one_unframed_page() {
    let scene = convert(ATTENTION_MAP);
    assert_well_formed(&scene);
    assert!(elements(&scene)
        .iter()
        .all(|element| element["type"] != "frame" && element["frameId"].is_null()));
    let count =
        |kind: &str| elements(&scene).iter().filter(|element| element["type"] == kind).count();
    assert_eq!((count("rectangle"), count("arrow")), (7, 6));

    let context = element(&scene, "context");
    assert_eq!(
        (number(&context["x"]), number(&context["y"]), number(&context["width"])),
        (1350., 400., 230.)
    );
    assert_eq!(context["strokeColor"], "#2f9e44");
    assert_eq!(context["backgroundColor"], "#ffffff");
    let label = element(&scene, "context-label");
    assert_eq!(label["containerId"], "context");
    assert_eq!(label["originalText"], "Context vectors\nInformation for each token");
    assert_eq!(label["fontFamily"], 6);

    let title = element(&scene, "title");
    assert_eq!((title["type"].as_str(), number(&title["fontSize"])), (Some("text"), 36.));
    let arrow = element(&scene, "q-to-scores");
    assert_eq!(arrow["points"], serde_json::json!([[0., 0.], [100., 63.]]));
    assert_eq!(
        (arrow["startArrowhead"].is_null(), arrow["endArrowhead"].as_str()),
        (true, Some("arrow"))
    );
}

#[test]
fn each_page_becomes_a_frame_laid_out_left_to_right() {
    let scene = convert(MULTI_PAGE);
    assert_well_formed(&scene);
    let frames: Vec<&Value> = elements(&scene)
        .iter()
        .filter(|element| {
            element["type"] == "frame" && element["id"].as_str().unwrap().starts_with("page-")
        })
        .collect();
    let names: Vec<&str> = frames.iter().map(|frame| frame["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Overview", "Experiments", "Scratch"]);
    for pair in frames.windows(2) {
        assert_eq!(number(&pair[1]["x"]), number(&pair[0]["x"]) + number(&pair[0]["width"]) + 200.);
        assert_eq!(pair[1]["y"], pair[0]["y"]);
    }
    assert_eq!((number(&frames[2]["width"]), number(&frames[2]["height"])), (800., 600.));

    // Shapes sit inside their page's frame and come before it in z-order.
    let position =
        |id: &str| elements(&scene).iter().position(|element| element["id"] == id).unwrap();
    let overview = frames[0];
    let caption = element(&scene, "caption");
    assert_eq!(caption["frameId"], "page-page");
    assert!(position("caption") < position("page-page"));
    for (element, frame) in
        [(element(&scene, "box"), overview), (element(&scene, "picture"), frames[1])]
    {
        assert!(
            number(&element["x"]) >= number(&frame["x"])
                && number(&element["x"]) + number(&element["width"])
                    <= number(&frame["x"]) + number(&frame["width"])
        );
        assert!(number(&element["y"]) >= number(&frame["y"]));
    }
    // The second page's shapes moved with its frame and kept their layout.
    let (picture, lost) = (element(&scene, "picture"), element(&scene, "lost"));
    assert_eq!(number(&lost["x"]) - number(&picture["x"]), 200.);
}

#[test]
fn shapes_map_onto_excalidraw_elements_and_styles() {
    let scene = convert(MULTI_PAGE);
    let kind = |id: &str| element(&scene, id)["type"].as_str().unwrap().to_string();
    assert_eq!(kind("box"), "rectangle");
    assert_eq!(kind("oval"), "ellipse");
    assert_eq!(kind("gem"), "diamond");
    assert_eq!(kind("cloud"), "ellipse");

    let box_ = element(&scene, "box");
    assert_eq!(
        (
            box_["strokeColor"].as_str(),
            box_["backgroundColor"].as_str(),
            box_["fillStyle"].as_str()
        ),
        (Some("#1971c2"), Some("#a5d8ff"), Some("solid"))
    );
    let oval = element(&scene, "oval");
    assert_eq!(
        (oval["fillStyle"].as_str(), oval["strokeStyle"].as_str()),
        (Some("hachure"), Some("dashed"))
    );
    let gem = element(&scene, "gem");
    assert_eq!(
        (gem["backgroundColor"].as_str(), number(&gem["strokeWidth"])),
        (Some("#40c057"), 4.)
    );
    assert!((number(&gem["angle"]) - std::f64::consts::FRAC_PI_6).abs() < 1e-6);
    let cloud = element(&scene, "cloud");
    assert_eq!(
        (cloud["strokeStyle"].as_str(), number(&cloud["strokeWidth"])),
        (Some("dotted"), 1.)
    );

    let sticky = element(&scene, "sticky");
    assert_eq!(
        (sticky["type"].as_str(), sticky["backgroundColor"].as_str()),
        (Some("rectangle"), Some("#ffec99"))
    );
    assert_eq!(element(&scene, "sticky-label")["originalText"], "Remember the **baseline**");

    let caption = element(&scene, "caption");
    assert_eq!(caption["text"], "Model overview\n• first\n• second");
    assert_eq!(number(&caption["fontSize"]), 36.);

    let zigzag = element(&scene, "zigzag");
    assert_eq!(zigzag["type"], "line");
    assert_eq!(zigzag["points"], serde_json::json!([[0., 0.], [50., 40.], [100., 0.]]));
    assert_eq!(zigzag["roundness"]["type"], 2);

    let scribble = element(&scene, "scribble");
    assert_eq!(scribble["type"], "freedraw");
    assert_eq!(scribble["points"], serde_json::json!([[0., 0.], [10., 5.], [20., 0.]]));
    assert_eq!(
        (scribble["strokeColor"].as_str(), scribble["simulatePressure"].as_bool()),
        (Some("#e8590c"), Some(true))
    );
    let marker = element(&scene, "marker");
    assert_eq!(
        (marker["type"].as_str(), marker["strokeColor"].as_str(), number(&marker["opacity"])),
        (Some("freedraw"), Some("#ffd43b"), 50.)
    );

    let note = element(&scene, "results-note");
    assert_eq!(note["frameId"], "results");
    assert!(element(&scene, "results")["frameId"].is_null());
    assert_eq!(element(&scene, "pair-a")["groupIds"], serde_json::json!(["pair"]));
}

#[test]
fn bound_arrows_keep_their_bindings_and_stop_at_the_shapes() {
    let scene = convert(MULTI_PAGE);
    let link = element(&scene, "link");
    assert_eq!(link["startBinding"]["elementId"], "box");
    assert_eq!(link["endBinding"]["elementId"], "oval");
    let (box_, oval) = (element(&scene, "box"), element(&scene, "oval"));
    let start = number(&link["x"]);
    let end = start + number(&link["points"][1][0]);
    assert!(start > number(&box_["x"]) + number(&box_["width"]), "the arrow leaves the box's edge");
    assert!(end < number(&oval["x"]), "and stops short of the ellipse");
    assert_eq!(element(&scene, "link-label")["text"], "feeds");
    assert_eq!(element(&scene, "link-label")["containerId"], "link");

    let curve = element(&scene, "curve");
    assert_eq!(curve["points"].as_array().unwrap().len(), 3);
    assert_eq!(curve["roundness"]["type"], 2);
    assert_eq!(
        (curve["startArrowhead"].as_str(), curve["endArrowhead"].as_str()),
        (Some("circle"), Some("triangle"))
    );
    assert!(curve["startBinding"].is_null());
}

#[test]
fn images_are_inlined_and_what_cannot_be_shown_becomes_a_labelled_box() {
    let scene = convert(MULTI_PAGE);
    let picture = element(&scene, "picture");
    assert_eq!(
        (picture["type"].as_str(), picture["status"].as_str()),
        (Some("image"), Some("saved"))
    );
    let file = &scene["files"][picture["fileId"].as_str().unwrap()];
    assert_eq!(file["mimeType"], "image/png");
    assert!(file["dataURL"].as_str().unwrap().starts_with("data:image/png;base64,iVBOR"));

    let lost = element(&scene, "lost");
    assert_eq!(
        (lost["type"].as_str(), lost["strokeStyle"].as_str()),
        (Some("rectangle"), Some("dashed"))
    );
    assert_eq!(element(&scene, "lost-label")["text"], "lost.png");

    let video = element(&scene, "video");
    assert_eq!(video["type"], "rectangle");
    assert_eq!(video["link"], "https://www.youtube.com/watch?v=iDulhoQ2pro");
    let paper = element(&scene, "paper-label");
    assert_eq!(
        paper["originalText"],
        "Attention Is All You Need\nhttps://arxiv.org/abs/1706.03762"
    );
}

#[test]
fn an_image_stored_beside_the_board_is_read_and_inlined() {
    let source = MULTI_PAGE.replace("https://example.com/figures/plot.png", "figures/plot.png");
    let png = include_bytes!("../../../icons/32x32.png").to_vec();
    let read = |path: &str| (path == "figures/plot.png").then(|| png.clone());
    let scene: Value =
        serde_json::from_str(&convert_tldr(&source, &read).unwrap().to_json()).unwrap();
    let plot = element(&scene, "plot");
    assert_eq!(plot["type"], "image");
    assert_eq!(scene["files"][plot["fileId"].as_str().unwrap()]["mimeType"], "image/png");
}

#[test]
fn converting_a_file_never_overwrites_and_leaves_the_original() {
    let folder =
        std::env::temp_dir().join(format!("lattice-board-convert-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&folder).unwrap();
    let board = folder.join("sketch.tldr");
    fs::write(&board, ATTENTION_MAP).unwrap();
    let names: Vec<String> = (0..3)
        .map(|_| {
            convert_tldr_file(&board).unwrap().file_name().unwrap().to_string_lossy().into_owned()
        })
        .collect();
    assert_eq!(
        names,
        ["sketch.excalidraw", "sketch (converted).excalidraw", "sketch (converted 2).excalidraw"]
    );
    assert_eq!(fs::read_to_string(&board).unwrap(), ATTENTION_MAP);
    assert_eq!(
        fs::read_to_string(folder.join("sketch.excalidraw")).unwrap(),
        convert_tldr(ATTENTION_MAP, &no_assets).unwrap().to_json()
    );
    fs::remove_dir_all(folder).unwrap();
}

#[test]
fn a_project_board_converts_to_a_project_path() {
    let fixture = crate::project::test_support::Fixture::folder("board-convert", "paper");
    fs::create_dir_all(fixture.root.join("boards")).unwrap();
    fs::write(fixture.root.join("boards/plan.tldr"), "").unwrap();
    fs::write(fixture.root.join("notes.md"), "").unwrap();
    assert_eq!(
        crate::project::convert_tldr_board(&fixture.root, "boards/plan.tldr").unwrap(),
        "boards/plan.excalidraw"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("boards/plan.excalidraw")).unwrap(),
        empty_scene()
    );
    assert!(crate::project::convert_tldr_board(&fixture.root, "notes.md").is_err());
    assert!(crate::project::convert_tldr_board(&fixture.root, "../plan.tldr").is_err());
}
