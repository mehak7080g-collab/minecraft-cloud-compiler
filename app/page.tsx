"use client";

import { useState } from "react";
import JSZip from "jszip";

type Report = { platform: string; project: string; minecraft: string; java: string; build: string; evidence: string[]; warnings: string[]; files: string[] };

const textFile = async (zip: JSZip, path: string) => {
  const file = zip.file(path);
  if (!file) return "";
  try { return (await file.async("string")).slice(0, 250_000); } catch { return ""; }
};

async function inspectZip(file: File): Promise<Report> {
  const zip = await JSZip.loadAsync(file, { checkCRC32: false });
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const lower = paths.map((p) => p.toLowerCase());
  const has = (suffix: string) => lower.some((p) => p.endsWith(suffix));
  const find = (name: string) => paths.find((p) => p.toLowerCase().endsWith(name));
  const evidence: string[] = [];
  const warnings: string[] = [];
  let platform = "Unknown Minecraft project";
  let project = "Unclassified";
  let minecraft = "Not detected";
  let java = "Not detected";
  let build = "No build system detected";

  const fabric = has("fabric.mod.json");
  const forge = has("mods.toml");
  const paper = has("plugin.yml") || has("paper-plugin.yml");
  const bedrock = has("manifest.json") && (has("pack_icon.png") || lower.some(p => p.includes("entities/") || p.includes("behavior_packs/") || p.includes("resource_packs/")));
  const maven = has("pom.xml");
  const gradle = has("build.gradle") || has("build.gradle.kts");
  const mcmeta = has("pack.mcmeta");

  if (bedrock) { platform = "Minecraft Bedrock"; project = "Add-on / Resource Pack"; evidence.push("Bedrock manifest and pack structure"); }
  if (!bedrock && (fabric || forge || has("neoforge.mods.toml"))) {
    platform = "Minecraft Java Edition";
    project = [fabric && "Fabric mod", forge && "Forge mod", has("neoforge.mods.toml") && "NeoForge mod"].filter(Boolean).join(" + ");
    evidence.push(...[fabric && "fabric.mod.json", forge && "META-INF/mods.toml", has("neoforge.mods.toml") && "META-INF/neoforge.mods.toml"].filter(Boolean) as string[]);
  }
  if (!bedrock && paper) { platform = "Minecraft Java Edition"; project = "Bukkit / Spigot / Paper plugin"; evidence.push("plugin.yml or paper-plugin.yml"); }
  if (mcmeta && !bedrock) { platform = "Minecraft Java Edition"; project = project === "Unclassified" ? "Resource pack" : project; evidence.push("pack.mcmeta"); }
  if (maven) { build = "Maven"; evidence.push("pom.xml"); }
  if (gradle) { build = maven ? "Maven + Gradle (multi-build; inspect manually)" : "Gradle"; evidence.push("Gradle build file"); }
  if (!maven && !gradle && bedrock) build = "Native Bedrock pack (no Java build)";
  if (maven && gradle) warnings.push("Both Maven and Gradle files are present. Build entry point needs manual confirmation.");
  if (!evidence.length) warnings.push("No reliable platform markers found. The compiler will not guess a build target.");
  if (paths.length > 5000) warnings.push("Large archive: only the first 5,000 paths are shown in this report.");
  if (paths.some(p => p.startsWith("/") || p.split("/").includes(".."))) warnings.push("Archive contains unusual paths. A secure extraction layer must reject path traversal.");

  const fabricPath = find("fabric.mod.json");
  if (fabricPath) {
    try {
      const data = JSON.parse(await textFile(zip, fabricPath));
      if (data.depends?.minecraft) minecraft = String(data.depends.minecraft);
      if (data.depends?.java) java = String(data.depends.java);
    } catch { warnings.push("fabric.mod.json exists but could not be parsed."); }
  }
  const pluginPath = find("plugin.yml") || find("paper-plugin.yml");
  if (pluginPath) {
    const yml = await textFile(zip, pluginPath);
    const version = yml.match(/^api-version:\s*['"]?([^\s'"#]+)/m);
    if (version) minecraft = "API " + version[1];
    const main = yml.match(/^main:\s*([^\s#]+)/m);
    if (main) evidence.push("Main class: " + main[1]);
  }
  const pomPath = find("pom.xml");
  if (pomPath) {
    const pom = await textFile(zip, pomPath);
    const release = pom.match(/<maven.compiler.release>\s*([^<]+)</) || pom.match(/<maven.compiler.source>\s*([^<]+)</);
    if (release) java = release[1].trim();
  }
  const gradlePath = find("build.gradle.kts") || find("build.gradle");
  if (gradlePath) {
    const gradleText = await textFile(zip, gradlePath);
    const mc = gradleText.match(/minecraftVersion\s*[=:]\s*["']([^"']+)/i) || gradleText.match(/minecraft\s*\(\s*["']([^"']+)/i);
    const jv = gradleText.match(/JavaVersion\.VERSION_([0-9_]+)/) || gradleText.match(/jvmToolchain\s*\(\s*(\d+)/);
    if (mc) minecraft = mc[1];
    if (jv) java = jv[1].replaceAll("_", ".");
  }
  if (platform === "Unknown Minecraft project") warnings.push("This is a structural preview only. It does not compile or execute uploaded code.");
  return { platform, project, minecraft, java, build, evidence, warnings, files: paths.slice(0, 80) };
}

export default function Home() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");

  async function onFile(file?: File) {
    if (!file) return;
    setError(""); setReport(null); setFileName(file.name); setBusy(true);
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Please upload a .zip archive of your project folder."); setBusy(false); return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError("This demo accepts ZIP files up to 50 MB. Cloud upload limits will be configured separately."); setBusy(false); return;
    }
    try { setReport(await inspectZip(file)); }
    catch { setError("Could not read this ZIP. Check that it is a valid, non-encrypted archive."); }
    finally { setBusy(false); }
  }

  return <main className="shell">
    <header className="top"><div className="brand">MINECRAFT <span>COMPILER</span></div><div className="pill">FREE COMMUNITY TOOL · PREVIEW</div></header>
    <section className="hero"><div className="eyebrow">STRUCTURE INTELLIGENCE · MILESTONE 01</div><h1>From project ZIP<br/>to build-ready.</h1><p className="sub">Upload a Minecraft project. The Structure Intelligence Engine inspects its files and identifies the likely platform, project type and build system — without running untrusted scripts.</p></section>
    <section className="panel">
      <div className="drop"><div className="upload-icon">⇧</div><h2>Drop your project ZIP here</h2><p className="muted">Java plugins · Mods · Bedrock add-ons · Resource packs</p><label className="primary" htmlFor="project">Choose ZIP file</label><input className="file-input" id="project" type="file" accept=".zip,application/zip" onChange={e => onFile(e.target.files?.[0])}/><div className="note">Browser-side inspection · Up to 50 MB · Files are not uploaded to a server</div></div>
      {busy && <div className="results">Inspecting archive structure…</div>}
      {error && <div className="warn">{error}</div>}
      {report && <div className="results"><h3>Structure report · {fileName}</h3><div className="grid">
        <div className="stat"><small>Platform</small><strong>{report.platform}</strong></div><div className="stat"><small>Project type</small><strong>{report.project}</strong></div>
        <div className="stat"><small>Minecraft version</small><strong>{report.minecraft}</strong></div><div className="stat"><small>Java version</small><strong>{report.java}</strong></div>
        <div className="stat"><small>Build system</small><strong>{report.build}</strong></div><div className="stat"><small>Files inspected</small><strong>{report.files.length}{report.files.length === 80 ? "+" : ""}</strong></div>
      </div>
      {report.evidence.length > 0 && <p className="muted">Evidence: {report.evidence.join(" · ")}</p>}
      {report.warnings.map((w,i)=><p className="warn" key={i}>⚠ {w}</p>)}
      <div className="filelist">{report.files.map(p=><div key={p}>{p}</div>)}</div>
      <p className="note">Build execution is not available in this milestone. No JAR or Bedrock package is generated yet.</p>
      </div>}
    </section>
    <section className="features"><div className="feature"><b>01 / Detect</b><p>Identify Java and Bedrock project markers with visible evidence.</p></div><div className="feature"><b>02 / Validate</b><p>Flag missing, conflicting or ambiguous project structure instead of guessing.</p></div><div className="feature"><b>03 / Build safely</b><p>Future isolated workers will compile projects without exposing repository secrets.</p></div></section>
    <footer>Built for the Minecraft community · Free by design · Cloud builds are not enabled yet</footer>
  </main>;
}
