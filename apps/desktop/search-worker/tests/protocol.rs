use serde_json::{json, Value};
use workbench_search_worker::{Request, Worker};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

fn call(worker: &mut Worker, input: Value) -> Value {
    worker.handle(serde_json::from_value::<Request>(input).unwrap()).unwrap()
}
fn doc(key: &str, revision: u64, body: &str, meta: Value) -> Value {
    json!({"key":key,"revision":revision,"mtime":revision,"text":body,
        "fields":{"title":""},"metadata":meta})
}
fn add(worker: &mut Worker, documents: Vec<Value>) -> Value { call(worker, json!({"op":"upsert","documents":documents})) }

#[test]
fn protocol_uses_one_process_and_keeps_consumer_ids_ordered() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_workbench-search-worker"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let frames = [
        json!({"version":1,"id":100,"op":"upsert","documents":[doc("item:one",1,"needle 📝",json!({"kind":"request","scope":"session"}))]}),
        json!({"version":1,"id":2,"op":"search","query":"needle"}),
        json!({"version":1,"id":101,"op":"search","query":"needle"}),
        json!({"version":2,"id":3,"op":"clear"}),
        json!({"version":1,"id":4,"op":"status"}),
        json!({"version":1,"id":5,"op":"shutdown"}),
    ];
    for frame in frames { writeln!(input,"{frame}").unwrap(); }
    drop(input);
    let replies: Vec<Value> = BufReader::new(child.stdout.take().unwrap()).lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap()).collect();
    assert!(child.wait().unwrap().success());
    assert_eq!(replies.iter().map(|r| r["id"].as_u64().unwrap()).collect::<Vec<_>>(),[100,2,101,3,4,5]);
    assert_eq!(replies[1]["result"]["total"],1);
    assert_eq!(replies[2]["result"]["total"],1);
    assert_eq!(replies[3]["ok"],false);
    assert_eq!(replies[4]["result"]["documents"],1);
    assert_eq!(replies[5]["result"]["stopped"],true);
}

#[test]
fn mutation_revisions_tombstones_and_hidden_sources_do_not_resurrect() {
    let mut worker = Worker::default();
    add(&mut worker, vec![doc("a",5,"oldword",json!({"scope":"session"}))]);
    assert_eq!(add(&mut worker,vec![doc("a",4,"lateword",json!({}))])["changed"],0);
    assert_eq!(call(&mut worker,json!({"op":"search","query":"oldword"}))["total"],1);
    call(&mut worker,json!({"op":"remove","documents":[{"key":"a","revision":6}]}));
    assert_eq!(add(&mut worker,vec![doc("a",5,"oldword",json!({}))])["changed"],0);
    assert_eq!(call(&mut worker,json!({"op":"status"}))["documents"],0);
    add(&mut worker,vec![doc("a",7,"freshword",json!({}))]);
    add(&mut worker,vec![doc("a",8,"privateword",json!({"hidden":true}))]);
    assert_eq!(call(&mut worker,json!({"op":"preview","key":"a","scope":{"archived":true}}))["found"],false);
    assert_eq!(call(&mut worker,json!({"op":"search","query":"privateword","scope":{"archived":true}}))["total"],0);
}

#[test]
fn exact_yaml_keys_and_empty_values_are_filters_without_changing_raw_text() {
    let mut worker = Worker::default();
    let raw="---\n\"DIKM_단계:\": [\"🔵 I\"]\n\"빈값:\":\n---\n원본 body 📝\n";
    let mut item=doc("note:a.md",1,raw,json!({"kind":"note","scope":"vault"}));
    item["fields"]["properties"]=json!([{"key":"DIKM_단계:","values":["🔵 I"]},{"key":"빈값:","values":[]}]);
    add(&mut worker,vec![item]);
    for filters in [json!([{"key":"DIKM_단계:","value":"🔵 I"}]),json!([{"key":"빈값:"}])] {
        assert_eq!(call(&mut worker,json!({"op":"search","query":"body","scope":{"properties":filters}}))["total"],1);
    }
    assert_eq!(call(&mut worker,json!({"op":"search","query":"body","scope":{"properties":[{"key":"DIKM_단계"}]}}))["total"],0);
    assert_eq!(call(&mut worker,json!({"op":"preview","key":"note:a.md"}))["text"],raw);
}

#[test]
fn scope_pagination_groups_and_dedup_use_all_candidates_before_page() {
    let mut worker = Worker::default();
    let docs=(0..80).map(|n| doc(&format!("item:{n}"),1,"needle body",json!({"kind":"request","scope":"session","workId":if n<70 {"blocked"}else{"allowed"},"sessionId":format!("s{}",n%2),"provider":"codex"}))).collect();
    add(&mut worker,docs);
    let result=call(&mut worker,json!({"op":"search","query":"needle","scope":{"workIds":["allowed"]},"offset":7,"limit":2,"includeCandidates":true}));
    assert_eq!(result["total"],10);
    assert_eq!(result["totalDocs"],10);
    assert_eq!(result["hits"].as_array().unwrap().len(),2);
    assert_eq!(result["candidates"].as_array().unwrap().len(),10);
    assert_eq!(call(&mut worker,json!({"op":"search","query":"needle","scope":{"keys":[]}}))["total"],0);
    let result=call(&mut worker,json!({"op":"search","query":"needle","scope":{"workIds":["allowed"]},"group":"session","offset":1,"limit":1,"perGroup":2}));
    assert_eq!(result["groups"].as_array().unwrap().len(),2);
    assert_eq!(result["groups"][0]["total"],5);
    assert_eq!(result["hits"].as_array().unwrap().len(),2);
    let mut chunks=vec![];
    for n in 0..2 { chunks.push(doc(&format!("chunk:{n}"),1,"uniquechunk",json!({"dedupKey":"one-message","kind":"reply"}))); }
    add(&mut worker,chunks);
    let result=call(&mut worker,json!({"op":"search","query":"uniquechunk","includeCandidates":true}));
    assert_eq!(result["total"],1);
    assert_eq!(result["counts"]["reply"],1);
}

#[test]
fn preview_and_related_respect_the_same_scope_as_search() {
    let mut worker=Worker::default();
    let mut docs=vec![];
    for (key,work,archived) in [("a.md","allowed",false),("b.md","blocked",false),("c.md","allowed",true),("d.md","allowed",false)] {
        let mut d=doc(key,1,"body",json!({"workId":work,"archived":archived}));
        d["fields"]["title"]=json!("Data Engineering"); docs.push(d);
    }
    add(&mut worker,docs);
    let scope=json!({"workIds":["allowed"]});
    assert_eq!(call(&mut worker,json!({"op":"preview","key":"b.md","scope":scope}))["found"],false);
    assert_eq!(call(&mut worker,json!({"op":"preview","key":"c.md","scope":scope}))["found"],false);
    let result=call(&mut worker,json!({"op":"similar","key":"a.md","scope":scope,"limit":1}));
    assert_eq!(result["hits"].as_array().unwrap().len(),1);
    assert_eq!(result["hits"][0]["path"],"d.md");
    assert_eq!(call(&mut worker,json!({"op":"similar","key":"b.md","scope":scope}))["hits"],json!([]));
}

#[test]
fn highlights_use_utf16_for_korean_and_emoji_prefixes() {
    let mut worker=Worker::default();
    let mut d=doc("note.md",1,"📝 한글 본문 needle 끝",json!({}));
    d["fields"]["title"]=json!("📝 한글 needle"); add(&mut worker,vec![d]);
    let result=call(&mut worker,json!({"op":"search","query":"needle"}));
    let h=&result["hits"][0];
    for (text,ranges) in [(h["titleNorm"].as_str().unwrap(),&h["titleRanges"]), (h["excerpt"]["text"].as_str().unwrap(),&h["excerpt"]["ranges"])] {
        let start=text[..text.find("needle").unwrap()].encode_utf16().count();
        assert!(ranges.as_array().unwrap().iter().any(|r| r==&json!([start,start+6])),"{h}");
    }
}

#[test]
fn invalid_batch_is_atomic_and_eof_is_a_normal_shutdown() {
    let mut worker=Worker::default();
    let request=serde_json::from_value(json!({"op":"upsert","documents":[doc("good",1,"body",json!({})),doc("",1,"invalid",json!({}))]})).unwrap();
    assert!(worker.handle(request).is_err());
    assert_eq!(call(&mut worker,json!({"op":"status"}))["documents"],0);
    let mut output=vec![];
    workbench_search_worker::serve(&mut std::io::Cursor::new(b""),&mut output).unwrap();
    assert!(output.is_empty());
}
