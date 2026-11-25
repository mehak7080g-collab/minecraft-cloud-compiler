"use client";

import { useMemo, useState } from "react";
import { upload } from "@vercel/blob/client";
import JSZip from "jszip";

type Report = { platform: string; project: string; minecraft: string; java: string; build: string; evidence: string[]; warnings: string[]; files: string[] };
type BuildResult = { ok: boolean; artifactPathname?: string; artifactName?: string; artifactBytes?: number; message?: string; logs?: string };

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
  const neoForge = has("neoforge.mods.toml");
  const paper = has("plugin.yml") || has("paper-plugin.yml");
  const bedrock = has("manifest.json") && (has("pack_icon.png") || lower.some(p => p.includes("behavior_packs/") || p.includes("resource_packs/")) || lower.some(p => p.endsWith("/manifest.json") || p === "manifest.json"));
  const maven = has("pom.xml");
  const gradle = has("build.gradle") || has("build.gradle.kts");
  const mcmeta = has("pack.mcmeta");

  if (bedrock) { platform = "Minecraft Bedrock"; project = "Add-on / Resource Pack"; evidence.push("Bedrock manifest and pack structure"); }
  if (!bedrock && (fabric || forge || neoForge)) {
    platform = "Minecraft Java Edition";
    project = [fabric && "Fabric mod", forge && "Forge mod", neoForge && "NeoForge mod"].filter(Boolean).join(" + ");
    evidence.push(...[fabric && "fabric.mod.json", forge && "META-INF/mods.toml", neoForge && "META-INF/neoforge.mods.toml"].filter(Boolean) as string[]);
  }
  if (!bedrock && paper) { platform = "Minecraft Java Edition"; project = "Bukkit / Spigot / Paper plugin"; evidence.push("plugin.yml or paper-plugin.yml"); }
  if (mcmeta && !bedrock) { platform = "Minecraft Java Edition"; project = project === "Unclassified" ? "Resource pack" : project; evidence.push("pack.mcmeta"); }
  if (maven) { build = "Maven"; evidence.push("pom.xml"); }
  if (gradle) { build = maven ? "Maven + Gradle (ambiguous)" : "Gradle"; evidence.push("Gradle build file"); }
  if (!maven && !gradle && bedrock) build = "Native Bedrock pack";
  if (maven && gradle) warnings.push("Both Maven and Gradle files are present. The cloud compiler will ask for a single build entry point.");
  if (!evidence.length) warnings.push("No reliable platform markers found. The compiler will not guess a build target.");
  if (paths.length > 5000) warnings.push("Large archive: only the first 5,000 paths are shown in this report.");
  if (paths.some(p => p.startsWith("/") || p.split("/").includes(".."))) warnings.push("Archive contains unusual paths. The server-side extractor rejects unsafe paths.");

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
  if (platform === "Unknown Minecraft project") warnings.push("This is a structural preview only. It does not execute uploaded code.");
  return { platform, project, minecraft, java, build, evidence, warnings, files: paths.slice(0, 80) };
}

export default function Home() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const [buildStatus, setBuildStatus] = useState("");

  const canBuild = useMemo(() => {
    if (!report) return false;
    if (report.platform === "Minecraft Bedrock") return report.project !== "Unclassified";
    return report.platform === "Minecraft Java Edition" && (report.build === "Maven" || report.build === "Gradle");
  }, [report]);

  async function onFile(file?: File) {
    if (!file) return;
    setError(""); setReport(null); setBuildResult(null); setBuildStatus(""); setFileName(file.name); setSelectedFile(file); setBusy(true);
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Please upload a .zip archive of your project folder."); setBusy(false); return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError("This compiler accepts ZIP files up to 50 MB."); setBusy(false); return;
    }
    try { setReport(await inspectZip(file)); }
    catch { setError("Could not read this ZIP. Check that it is a valid, non-encrypted archive."); }
    finally { setBusy(false); }
  }

  async function compileProject() {
    if (!selectedFile || !canBuild || compiling) return;
    setError(""); setBuildResult(null); setCompiling(true);
    try {
      setBuildStatus("Uploading ZIP to private temporary storage…");
      const pathname = `incoming/${crypto.randomUUID()}/project.zip`;
      const uploaded = await upload(pathname, selectedFile, {
        access: "private",
        handleUploadUrl: "/api/upload",
        multipart: false,
      });
      setBuildStatus("Starting an isolated cloud worker…");
      const response = await fetch("/api/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pathname: uploaded.pathname, originalName: selectedFile.name }),
      });
      const result = await response.json() as BuildResult;
      setBuildResult(result);
      if (!response.ok || !result.ok) setError(result.message || "Build failed. Review the build log below.");
      else setBuildStatus("Build completed. Your artifact is ready.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cloud build could not be started.");
    } finally {
      setCompiling(false);
    }
  }

  return <main className="shell">
    <header className="top"><div className="brand">MINECRAFT <span>COMPILER</span></div><div className="pill">FREE COMMUNITY TOOL · EARLY ACCESS</div></header>
    <section className="hero"><div className="eyebrow">STRUCTURE INTELLIGENCE · CLOUD BUILDS</div><h1>From project ZIP<br/>to build-ready.</h1><p className="sub">Upload a Minecraft project. The compiler identifies its platform, checks its structure and builds supported projects inside an isolated cloud worker.</p></section>
    <section className="panel">
      <div className="drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}><div className="upload-icon">⇧</div><h2>Drop your project ZIP here</h2><p className="muted">Java plugins · Mods · Bedrock add-ons · Resource packs</p><label className="primary" htmlFor="project">Choose ZIP file</label><input className="file-input" id="project" type="file" accept=".zip,application/zip" onChange={e => onFile(e.target.files?.[0])}/><div className="note">Private temporary upload · Up to 50 MB · No build secrets are passed to workers</div></div>
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
      <button className="primary" onClick={compileProject} disabled={!canBuild || compiling}>{compiling ? "Building in cloud…" : "Compile in Cloud"}</button>
      {!canBuild && <p className="note">This project does not yet match a supported build path. Bedrock packs are packaged; Java projects need a Maven POM or a Gradle wrapper.</p>}
      {buildStatus && <p className="muted">{buildStatus}</p>}
      {buildResult?.ok && buildResult.artifactPathname && <div className="download"><b>Build successful</b><p className="muted">{buildResult.artifactName} · {((buildResult.artifactBytes || 0) / 1024).toFixed(1)} KB</p><a className="primary" href={`/api/download?pathname=${encodeURIComponent(buildResult.artifactPathname)}`}>Download {buildResult.artifactName}</a></div>}
      {buildResult?.logs && <details className="logs" open={!buildResult.ok}><summary>Build log</summary><pre>{buildResult.logs}</pre></details>}
      <p className="note">Java builds run in disposable Firecracker workers with no project secrets. Tests are skipped. Builds have a 4-minute worker limit and finite free-tier quotas.</p>
      </div>}
    </section>
    <section className="features"><div className="feature"><b>01 / Detect</b><p>Identify Java and Bedrock project markers with visible evidence.</p></div><div className="feature"><b>02 / Validate</b><p>Reject unsafe archive paths and flag conflicting project structures.</p></div><div className="feature"><b>03 / Build safely</b><p>Build Java projects in isolated workers or package Bedrock add-ons natively.</p></div></section>
    <footer>Built for the Minecraft community · Free by design · Monthly compute and storage limits apply</footer>
  </main>;
}
