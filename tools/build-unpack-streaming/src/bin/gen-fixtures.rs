//! Generate committed LZMA test fixtures for tools/tests/unpack-lzma.test.ts
//!
//! Run: cargo run --bin gen-fixtures --manifest-path tools/build-unpack-streaming/Cargo.toml

use lzma_rust2::{Lzma2Options, Lzma2Writer, LzmaOptions, LzmaWriter};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/inno/lzma")
}

fn lzma1_options(dict_size: u32) -> LzmaOptions {
    let mut opts = LzmaOptions::with_preset(6);
    opts.dict_size = dict_size;
    opts
}

fn write_lzma1_fixture(name: &str, plaintext: &[u8], options: &LzmaOptions) {
    let dir = fixture_dir();
    fs::create_dir_all(&dir).expect("mkdir fixtures");

    let mut compressed = Vec::new();
    let mut writer = LzmaWriter::new_no_header(&mut compressed, options, true).expect("LzmaWriter");
    writer.write_all(plaintext).expect("write plaintext");
    writer.finish().expect("finish lzma1");

    let props = options.get_props();
    let mut props_buf = vec![props];
    props_buf.extend_from_slice(&options.dict_size.to_le_bytes());
    fs::write(dir.join(format!("{name}.props")), &props_buf).expect("write props");
    fs::write(dir.join(format!("{name}.lzma1")), &compressed).expect("write lzma1");
    fs::write(dir.join(format!("{name}.txt")), plaintext).expect("write expected");
}

fn write_lzma2_fixture(name: &str, plaintext: &[u8], dict_size: u32) {
    let dir = fixture_dir();
    fs::create_dir_all(&dir).expect("mkdir fixtures");

    let mut opts = Lzma2Options::with_preset(6);
    opts.lzma_options.dict_size = dict_size;

    let mut compressed = Vec::new();
    let mut writer = Lzma2Writer::new(&mut compressed, opts);
    writer.write_all(plaintext).expect("write lzma2");
    writer.finish().expect("finish lzma2");

    fs::write(dir.join(format!("{name}.props")), dict_size.to_le_bytes()).expect("write props");
    fs::write(dir.join(format!("{name}.lzma2")), &compressed).expect("write lzma2");
    fs::write(dir.join(format!("{name}.txt")), plaintext).expect("write expected");
}

fn main() {
    let lzma1_opts = lzma1_options(1 << 20);
    write_lzma1_fixture("hello", b"Hello, Inno LZMA1!", &lzma1_opts);
    write_lzma2_fixture("hello-lzma2", b"Hello, Inno LZMA2!", LzmaOptions::DICT_SIZE_DEFAULT);
    write_lzma1_fixture("binary", &(0u8..=255).collect::<Vec<u8>>(), &lzma1_opts);
    eprintln!("Wrote fixtures to {}", fixture_dir().display());
}
