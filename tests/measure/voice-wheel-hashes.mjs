#!/usr/bin/env node
// Prints lib/voice/requirements.txt with a sha256 for every wheel pip may install from it, read
// from PyPI's JSON API, for whoever moves a pin there: run it, check the output, put it in the file.
//
//   node tests/measure/voice-wheel-hashes.mjs
//
// Voice input installs with --require-hashes (lib/chat/voice.mjs), so a wheel whose sha256 is not
// on its line is refused. A line lists every wheel of its version that pip may pick on a platform
// voice input runs on, with the CPython it runs (PYTHON in lib/chat/voice.mjs, 3.13): Linux on
// glibc (manylinux) and macOS, each on x86_64 and arm64. Every macOS version a wheel is built for
// is there, because pip picks the newest one the Mac it runs on accepts: numpy ships one arm64
// wheel for macOS 11 and another for 14. musllinux, Windows and the other machines are left out.
// The comment lines at the top of the file are printed as they are.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIREMENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "voice", "requirements.txt");
const CPYTHON = 313;

// Whether a wheel's tags fit CPython 3.13 on one of the platforms: its file name ends in
// python-abi-platform, each a set joined with dots.
export function fits(filename) {
  const [pythons, abis, platforms] = filename.replace(/\.whl$/, "").split("-").slice(-3).map((tags) => tags.split("."));
  const python = pythons.some((tag) => tag === "py3" || tag === `cp${CPYTHON}` || (abis.includes("abi3") && /^cp3\d+$/.test(tag) && Number(tag.slice(2)) <= CPYTHON));
  const abi = abis.some((tag) => tag === "none" || tag === "abi3" || tag === `cp${CPYTHON}`);
  const platform = platforms.some((tag) => tag === "any" || /^manylinux.*_(x86_64|aarch64)$/.test(tag) || /^macosx_\d+_\d+_(x86_64|arm64|universal2)$/.test(tag));
  return python && abi && platform;
}

async function hashed(line) {
  const [requirement, marker] = line.split(/\s*;\s*/);
  const [name, version] = requirement.split("==");
  const response = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
  if (!response.ok) throw new Error(`PyPI answered ${response.status} for ${name} ${version}`);
  const wheels = (await response.json()).urls.filter((file) => file.packagetype === "bdist_wheel" && fits(file.filename));
  if (wheels.length === 0) throw new Error(`${name} ${version} has no wheel for any platform voice input runs on`);
  const sums = [...new Set(wheels.map((file) => file.digests.sha256))].sort();
  return [`${requirement}${marker === undefined ? "" : ` ; ${marker}`} \\`, ...sums.map((sum, at) => `    --hash=sha256:${sum}${at < sums.length - 1 ? " \\" : ""}`)].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lines = fs.readFileSync(REQUIREMENTS, "utf8").split("\n");
  const notes = lines.filter((line) => line.startsWith("#"));
  const requirements = lines.filter((line) => /^[a-z]/i.test(line)).map((line) => line.replace(/\s*\\$/, ""));
  const out = [];
  for (const line of requirements) out.push(await hashed(line));
  process.stdout.write(`${[...notes, ...out].join("\n")}\n`);
}
