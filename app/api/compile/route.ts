import { del, get, list, put } from "@vercel/blob";
import { Sandbox } from "@vercel/sandbox";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_UPLOAD = 50 * 1024 * 1024;
const WORKER_TIMEOUT = 240_000;

const NETWORK_ALLOW = {
  allow: {
    "archive.ubuntu.com": [],
    "security.ubuntu.com": [],
    "*.ubuntu.com": [],
    "*.debian.org": [],
    "repo.maven.apache.org": [],
    "repo1.maven.org": [],
    "plugins.gradle.org": [],
    "services.gradle.org": [],
    "downloads.gradle.org": [],
    "github.com": [],
    "objects.githubusercontent.com": [],
    "release-assets.githubusercontent.com": [],
    "maven.fabricmc.net": [],
    "maven.lavalink.dev": [],
    "maven.minecraftforge.net": [],
    "files.minecraftforge.net": [],
    "maven.neoforged.net": [],
    "repo.papermc.io": [],
    "hub.spigotmc.org": [],
    "repo.spongepowered.org": [],
    "libraries.minecraft.net": [],
    "piston-meta.mojang.com": [],
    "piston-data.mojang.com": [],
    "resources.download.minecraft.net": [],
    "launchermeta.mojang.com": [],
    "launcher.mojang.com": [],
    "launchercontent.mojang.com": [],
    "textures.minecraft.net": [],
    "maven-central.storage-download.googleapis.com": [],
    "maven.google.com": [],
    "dl.google.com": [],
  },
};

const INSPECT_SCRIPT = "import json, os, re, stat, sys, zipfile\nfrom pathlib import Path, PurePosixPath\nfrom urllib.parse import urlparse\n\narchive_path = Path(\"/vercel/sandbox/input.zip\")\nbase = Path(\"/vercel/sandbox/work\").resolve()\nbase.mkdir(parents=True, exist_ok=True)\nMAX_FILES = 5000\nMAX_FILE = 64 * 1024 * 1024\nMAX_TOTAL = 250 * 1024 * 1024\n\ndef fail(message):\n    print(json.dumps({\"ok\": False, \"error\": message}))\n    sys.exit(2)\n\ntry:\n    with zipfile.ZipFile(archive_path) as zf:\n        infos = [i for i in zf.infolist() if not i.is_dir()]\n        if not infos:\n            fail(\"The ZIP is empty.\")\n        if len(infos) > MAX_FILES:\n            fail(\"The ZIP contains too many files (limit: 5,000).\")\n        declared_total = 0\n        safe_entries = []\n        for info in infos:\n            name = info.filename.replace(\"\\\\\", \"/\")\n            posix = PurePosixPath(name)\n            parts = [p for p in posix.parts if p not in (\"\", \".\")]\n            if not parts or posix.is_absolute() or \"..\" in parts or \":\" in parts[0] or \"\\x00\" in name:\n                fail(\"Unsafe path found in ZIP: \" + name[:160])\n            mode = (info.external_attr >> 16) & 0xFFFF\n            if stat.S_ISLNK(mode):\n                fail(\"Symbolic links are not accepted in project archives.\")\n            if info.file_size < 0 or info.file_size > MAX_FILE:\n                fail(\"A file exceeds the 64 MB per-file extraction limit.\")\n            declared_total += info.file_size\n            if declared_total > MAX_TOTAL:\n                fail(\"Uncompressed project is larger than the 250 MB safety limit.\")\n            if info.file_size > 1024 * 1024 and info.compress_size > 0 and info.file_size / info.compress_size > 300:\n                fail(\"The ZIP contains an unusually compressed file and was rejected.\")\n            safe_entries.append((info, parts))\n\n        actual_total = 0\n        for info, parts in safe_entries:\n            target = (base.joinpath(*parts)).resolve()\n            if target != base and base not in target.parents:\n                fail(\"ZIP path escapes the extraction directory.\")\n            target.parent.mkdir(parents=True, exist_ok=True)\n            # Credentials/config secrets in an uploaded ZIP are deliberately not copied into the build worker.\n            lower_name = target.name.lower()\n            if lower_name.startswith(\".env\") or lower_name in (\".npmrc\", \".netrc\", \".git-credentials\", \"settings.xml\", \"local.properties\"):\n                continue\n            if lower_name == \"gradle.properties\":\n                # Preserve build configuration while removing credential-like properties.\n                raw_properties = zf.read(info).decode(\"utf-8-sig\", errors=\"replace\")\n                safe_lines = []\n                for line in raw_properties.splitlines():\n                    if re.match(r\"^\\s*[^#!=]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[^#!=]*\\s*[:=]\", line, re.I):\n                        continue\n                    safe_lines.append(line)\n                safe_properties = (\"\\n\".join(safe_lines) + \"\\n\").encode(\"utf-8\")\n                actual_total += len(safe_properties)\n                if actual_total > MAX_TOTAL:\n                    fail(\"Extracted project exceeded the configured size limit.\")\n                target.write_bytes(safe_properties)\n                continue\n            written = 0\n            with zf.open(info, \"r\") as source, open(target, \"wb\") as dest:\n                while True:\n                    chunk = source.read(1024 * 1024)\n                    if not chunk:\n                        break\n                    written += len(chunk)\n                    actual_total += len(chunk)\n                    if written > MAX_FILE or actual_total > MAX_TOTAL:\n                        fail(\"Extracted project exceeded the configured size limit.\")\n                    dest.write(chunk)\n\n    all_files = [p for p in base.rglob(\"*\") if p.is_file() and not p.is_symlink()]\n    rels = [p.relative_to(base).as_posix() for p in all_files]\n    low = [r.lower() for r in rels]\n\n    # Recognize Bedrock packs from their manifest locations and validate the manifests.\n    manifest_paths = [p for p in all_files if p.name.lower() == \"manifest.json\"]\n    pack_dirs = set()\n    nested_pack_dirs = set()\n    for manifest in manifest_paths:\n        rel_parts = manifest.relative_to(base).parts\n        parent = manifest.parent\n        if any(part.lower() in (\"behavior_packs\", \"resource_packs\") for part in rel_parts[:-1]):\n            nested_pack_dirs.add(parent)\n        elif len(rel_parts) == 1:\n            pack_dirs.add(parent)\n        else:\n            pack_dirs.add(parent)\n\n    # Prefer explicit resource/behavior pack roots when present.\n    if nested_pack_dirs:\n        pack_dirs = nested_pack_dirs\n    bedrock_packs = []\n    manifest_errors = []\n    for pack_dir in sorted(pack_dirs):\n        manifest = pack_dir / \"manifest.json\"\n        try:\n            data = json.loads(manifest.read_text(encoding=\"utf-8-sig\"))\n            if not isinstance(data.get(\"header\"), dict) or not isinstance(data.get(\"modules\"), list) or not data[\"modules\"]:\n                manifest_errors.append(manifest.relative_to(base).as_posix())\n            else:\n                bedrock_packs.append({\n                    \"path\": pack_dir.relative_to(base).as_posix(),\n                    \"name\": str(data[\"header\"].get(\"name\", pack_dir.name))[:80],\n                })\n        except Exception:\n            manifest_errors.append(manifest.relative_to(base).as_posix())\n\n    java_markers = []\n    for marker in (\"pom.xml\", \"build.gradle\", \"build.gradle.kts\", \"fabric.mod.json\", \"mods.toml\", \"neoforge.mods.toml\", \"plugin.yml\", \"paper-plugin.yml\"):\n        if marker in low:\n            java_markers.extend([r for r in rels if r.lower().endswith(\"/\" + marker) or r.lower() == marker])\n\n    if bedrock_packs and java_markers:\n        fail(\"Both Bedrock pack manifests and Java build markers were found. Separate the projects into different ZIP files.\")\n    if manifest_errors and not bedrock_packs:\n        fail(\"Bedrock manifest.json could not be validated: \" + \", \".join(manifest_errors[:4]))\n    if bedrock_packs:\n        print(json.dumps({\"ok\": True, \"kind\": \"bedrock\", \"packs\": bedrock_packs}))\n        sys.exit(0)\n\n    build_files = [p for p in all_files if p.name.lower() in (\"pom.xml\", \"build.gradle\", \"build.gradle.kts\", \"settings.gradle\", \"settings.gradle.kts\")]\n    pom_roots = {p.parent for p in build_files if p.name.lower() == \"pom.xml\"}\n    gradle_roots = {p.parent for p in build_files if p.name.lower() in (\"build.gradle\", \"build.gradle.kts\")}\n    settings_roots = {p.parent for p in build_files if p.name.lower() in (\"settings.gradle\", \"settings.gradle.kts\")}\n\n    if pom_roots and gradle_roots:\n        fail(\"Both Maven and Gradle build files are present. Automatic selection is disabled for ambiguous projects.\")\n    if pom_roots:\n        roots = pom_roots\n        build_system = \"maven\"\n    elif gradle_roots:\n        roots = settings_roots if settings_roots else gradle_roots\n        build_system = \"gradle\"\n    else:\n        fail(\"No supported Java build descriptor or Bedrock manifest was found. Java projects need pom.xml or a Gradle build with its wrapper.\")\n\n    if len(roots) != 1:\n        fail(\"Multiple project roots were found. Put one buildable project in each ZIP.\")\n    root = next(iter(roots)).resolve()\n    if root != base and base not in root.parents:\n        fail(\"Detected project root is outside the extraction directory.\")\n\n    gradle_version = None\n    gradle_wrapper = False\n    if build_system == \"gradle\":\n        wrapper = root / \"gradlew\"\n        props = root / \"gradle\" / \"wrapper\" / \"gradle-wrapper.properties\"\n        if wrapper.is_file() and props.is_file():\n            prop_text = props.read_text(encoding=\"utf-8\", errors=\"replace\")\n            match = re.search(r\"^distributionUrl\\s*=\\s*(.+)$\", prop_text, re.M)\n            if not match:\n                fail(\"Gradle wrapper distribution URL is missing.\")\n            url = match.group(1).replace(\"\\\\:\", \":\").replace(\"\\\\\\\\\", \"\")\n            host = (urlparse(url).hostname or \"\").lower()\n            if host not in (\"services.gradle.org\", \"downloads.gradle.org\"):\n                fail(\"Gradle wrapper must use the official services.gradle.org or downloads.gradle.org host.\")\n            if not url.startswith(\"https://\"):\n                fail(\"Gradle wrapper must use HTTPS.\")\n            version_match = re.search(r\"gradle-([0-9]+(?:\\.[0-9]+){1,2})-(?:bin|all)\\.zip\", url)\n            if not version_match:\n                fail(\"Gradle wrapper distribution version could not be identified.\")\n            gradle_version = version_match.group(1)\n            gradle_wrapper = True\n        else:\n            # Wrapper-less projects are supported. Prefer their own bootstrap metadata,\n            # such as GRADLE_VERSION in build.bat/build.sh, then use a known default.\n            candidates = []\n            for path in all_files:\n                if path.parent == root and path.name.lower() in (\n                    \"build.bat\", \"build.cmd\", \"build.sh\", \"readme.md\", \"gradle.properties\",\n                    \"settings.gradle\", \"settings.gradle.kts\", \"build.gradle\", \"build.gradle.kts\"\n                ):\n                    if path.stat().st_size <= 2 * 1024 * 1024:\n                        try:\n                            candidates.append(path.read_text(encoding=\"utf-8\", errors=\"replace\"))\n                        except Exception:\n                            pass\n            patterns = [\n                r\"(?im)^\\s*(?:set\\s+)?GRADLE_VERSION\\s*=\\s*['\\\"]?([0-9]+\\.[0-9]+(?:\\.[0-9]+)?)\",\n                r\"(?i)gradle-([0-9]+\\.[0-9]+(?:\\.[0-9]+)?)-(?:bin|all)\\.zip\",\n                r\"(?i)gradleVersion\\s*[:=]\\s*['\\\"]([0-9]+\\.[0-9]+(?:\\.[0-9]+)?)['\\\"]\",\n            ]\n            for source_text in candidates:\n                for pattern in patterns:\n                    detected = re.search(pattern, source_text)\n                    if detected:\n                        gradle_version = detected.group(1)\n                        break\n                if gradle_version:\n                    break\n            if not gradle_version:\n                gradle_version = \"9.2.1\"\n\n    plugin = any(r.lower().endswith(\"/plugin.yml\") or r.lower() == \"plugin.yml\" or r.lower().endswith(\"/paper-plugin.yml\") for r in rels)\n    fabric = any(r.lower().endswith(\"/fabric.mod.json\") or r.lower() == \"fabric.mod.json\" for r in rels)\n    forge = any(r.lower().endswith(\"/mods.toml\") for r in rels)\n    neo = any(r.lower().endswith(\"/neoforge.mods.toml\") for r in rels)\n    project_type = \"Java project\"\n    if plugin: project_type = \"Bukkit / Spigot / Paper plugin\"\n    elif fabric: project_type = \"Fabric mod\"\n    elif neo: project_type = \"NeoForge mod\"\n    elif forge: project_type = \"Forge mod\"\n\n    print(json.dumps({\n        \"ok\": True,\n        \"kind\": \"java\",\n        \"buildSystem\": build_system,\n        \"gradleVersion\": gradle_version,\n        \"gradleWrapper\": gradle_wrapper,\n        \"root\": str(root),\n        \"projectType\": project_type,\n    }))\nexcept zipfile.BadZipFile:\n    fail(\"The uploaded file is not a valid ZIP archive.\")\nexcept Exception as exc:\n    fail(\"Project inspection failed: \" + str(exc)[:300])\n";
const BEDROCK_SCRIPT = "import json, shutil, sys, zipfile\nfrom pathlib import Path\n\nbase = Path(\"/vercel/sandbox/work\").resolve()\nreport = json.loads(Path(\"/vercel/sandbox/inspection.json\").read_text())\npacks = report.get(\"packs\", [])\nif not packs:\n    raise SystemExit(\"No valid Bedrock packs were detected.\")\ntemporary = []\nfor index, item in enumerate(packs):\n    folder = (base / item[\"path\"]).resolve()\n    if folder != base and base not in folder.parents:\n        raise SystemExit(\"Unsafe Bedrock pack path.\")\n    manifest = folder / \"manifest.json\"\n    if not manifest.is_file():\n        raise SystemExit(\"A Bedrock pack is missing manifest.json.\")\n    name = f\"pack-{index + 1}-{folder.name}.mcpack\"\n    output = Path(\"/vercel/sandbox\") / name\n    with zipfile.ZipFile(output, \"w\", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:\n        for path in folder.rglob(\"*\"):\n            if path.is_file() and not path.is_symlink():\n                archive.write(path, path.relative_to(folder).as_posix())\n    temporary.append((output, name))\n\nif len(temporary) == 1:\n    shutil.copyfile(temporary[0][0], \"/vercel/sandbox/result.mcpack\")\n    print(json.dumps({\"ok\": True, \"extension\": \"mcpack\", \"name\": temporary[0][1]}))\nelse:\n    with zipfile.ZipFile(\"/vercel/sandbox/result.mcaddon\", \"w\", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as addon:\n        for output, name in temporary:\n            addon.write(output, name)\n    print(json.dumps({\"ok\": True, \"extension\": \"mcaddon\", \"name\": \"minecraft-addon.mcaddon\", \"packs\": len(temporary)}))\n";
const JAR_SCRIPT = "import json, shutil, sys\nfrom pathlib import Path\n\nroot = Path(sys.argv[1]).resolve()\nbase = Path(\"/vercel/sandbox/work\").resolve()\nif root != base and base not in root.parents:\n    raise SystemExit(\"Invalid project root.\")\nitems = []\nfor path in root.rglob(\"*.jar\"):\n    if not path.is_file() or path.is_symlink():\n        continue\n    parts = [p.lower() for p in path.parts]\n    name = path.name.lower()\n    if any(x in parts for x in (\".gradle\", \".git\")):\n        continue\n    if any(token in name for token in (\"-sources\", \"-javadoc\", \"-dev\", \"-original\", \"-tests\", \"-test\")):\n        continue\n    if path.stat().st_size < 128:\n        continue\n    preferred = 1 if (\"build\" in parts and \"libs\" in parts) or \"target\" in parts else 0\n    items.append((preferred, path.stat().st_size, path))\nif not items:\n    raise SystemExit(\"The build finished but no distributable JAR was found in build/libs or target.\")\nitems.sort(key=lambda x: (x[0], x[1]), reverse=True)\nselected = items[0][2]\nif selected.stat().st_size > 100 * 1024 * 1024:\n    raise SystemExit(\"The generated JAR exceeds the 100 MB artifact limit.\")\nshutil.copyfile(selected, \"/vercel/sandbox/result.jar\")\nprint(json.dumps({\"ok\": True, \"name\": selected.name, \"bytes\": selected.stat().st_size}))\n";


const FABRIC_LOOM_REPOSITORY_FIX_SCRIPT = String.raw`import re, sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
settings = next((p for p in (root / 'settings.gradle', root / 'settings.gradle.kts') if p.is_file()), None)
build = next((p for p in (root / 'build.gradle', root / 'build.gradle.kts') if p.is_file()), None)
if not settings or not build:
    print('No settings.gradle/build.gradle pair found; no compatibility patch needed.')
    raise SystemExit(0)

settings_text = settings.read_text(encoding='utf-8', errors='replace')
build_text = build.read_text(encoding='utf-8', errors='replace')
if not re.search(r'net\.fabricmc\.fabric-loom|fabric-loom', build_text, re.I):
    print('Fabric Loom plugin not detected; no repository compatibility patch needed.')
    raise SystemExit(0)

def find_block(source, marker):
    match = re.search(marker + r'\s*\{', source, re.I)
    if not match:
        return None
    start = source.find('{', match.start())
    depth, quote, escaped = 0, None, False
    for i in range(start, len(source)):
        ch = source[i]
        if quote:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return source[start + 1:i]
    return None

drm = find_block(settings_text, r'\bdependencyResolutionManagement')
repo_body = find_block(drm, r'\brepositories') if drm is not None else None
repo_entries = []
if repo_body is not None:
    for match in re.finditer(r'\bmaven\s*\{[^}]*?\burl\s*=\s*(?:uri\s*\()?\s*[\'"]([^\'"]+)[\'"]', repo_body, re.I | re.S):
        url = match.group(1)
        if url not in [item[1] for item in repo_entries]:
            repo_entries.append(('maven', url))
    for method in ('mavenCentral', 'mavenLocal', 'google'):
        if re.search(r'\b' + method + r'\s*\(\s*\)', repo_body) and not any(item[0] == method for item in repo_entries):
            repo_entries.append((method, ''))

if not repo_entries:
    repo_entries = [('maven', 'https://maven.fabricmc.net/'), ('mavenCentral', '')]

new_settings = settings_text
new_settings, policy_count = re.subn(
    r'RepositoriesMode\.(?:FAIL_ON_PROJECT_REPOS|PREFER_SETTINGS)',
    'RepositoriesMode.PREFER_PROJECT',
    new_settings,
)
if policy_count == 0 and drm is not None and not re.search(r'RepositoriesMode\.PREFER_PROJECT', drm):
    match = re.search(r'\bdependencyResolutionManagement\s*\{', new_settings, re.I)
    if match:
        pos = match.end()
        new_settings = new_settings[:pos] + '\n    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)' + new_settings[pos:]

lines = []
for kind, value in repo_entries:
    if kind == 'maven':
        escaped = value.replace('\\', '\\\\').replace('"', '\\"')
        lines.append(f'        maven {{ url = uri("{escaped}") }}')
    else:
        lines.append(f'        {kind}()')

repo_block = (
    '\n// Added by Minecraft Cloud Compiler: retain settings repositories when Fabric Loom adds its local remapped-mod repository.\n'
    'allprojects {\n    repositories {\n'
    + '\n'.join(lines)
    + '\n    }\n}\n'
)
if 'Minecraft Cloud Compiler: retain settings repositories' not in build_text:
    build_text = build_text.rstrip() + '\n' + repo_block

settings.write_text(new_settings, encoding='utf-8')
build.write_text(build_text, encoding='utf-8')
print('Applied Fabric Loom repository-policy compatibility fix.')
print('Changed settings repository mode to PREFER_PROJECT so Loom can register LoomLocalRemappedMods.')
print('Preserved dependency repositories: ' + ', '.join((kind if kind != 'maven' else url) for kind, url in repo_entries))
`;

function trimLog(value: string) {
  return value.length > 18_000 ? value.slice(-18_000) : value;
}

async function cleanupExpiredArtifacts() {
  try {
    const { blobs } = await list({ prefix: "artifacts/", limit: 1000 });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const expired = blobs.filter((blob) => Date.parse(String(blob.uploadedAt)) < cutoff).map((blob) => blob.pathname);
    if (expired.length) await del(expired);
  } catch {
    // Cleanup is best-effort; a build should not fail because old artifacts could not be listed.
  }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return Response.json({ ok: false, message: "Cross-origin build requests are not accepted." }, { status: 403 });
      }
    } catch {
      return Response.json({ ok: false, message: "Invalid request origin." }, { status: 403 });
    }
  }

  let pathname = "";
  let sandbox: Sandbox | null = null;
  let logs = "";
  try {
    const body = await request.json() as { pathname?: string; originalName?: string };
    pathname = String(body.pathname || "");
    if (!/^incoming\/[a-f0-9-]{30,40}\/[a-zA-Z0-9._-]{1,120}\.zip$/i.test(pathname) || pathname.includes("..")) {
      return Response.json({ ok: false, message: "Invalid temporary ZIP path. Upload the project again." }, { status: 400 });
    }

    const source = await get(pathname, { access: "private" });
    if (!source || source.statusCode !== 200) {
      return Response.json({ ok: false, message: "Uploaded ZIP was not found. Please upload it again." }, { status: 404 });
    }
    const inputBuffer = Buffer.from(await new Response(source.stream).arrayBuffer());
    if (!inputBuffer.length || inputBuffer.length > MAX_UPLOAD) {
      return Response.json({ ok: false, message: "ZIP must be between 1 byte and 50 MB." }, { status: 413 });
    }

    await cleanupExpiredArtifacts();
    sandbox = await Sandbox.create({
      resources: { vcpus: 1 },
      timeout: WORKER_TIMEOUT,
      persistent: false,
      networkPolicy: NETWORK_ALLOW,
    });

    await sandbox.writeFiles([
      { path: "/vercel/sandbox/input.zip", content: inputBuffer },
      { path: "/vercel/sandbox/inspect.py", content: Buffer.from(INSPECT_SCRIPT) },
      { path: "/vercel/sandbox/package_bedrock.py", content: Buffer.from(BEDROCK_SCRIPT) },
      { path: "/vercel/sandbox/select_jar.py", content: Buffer.from(JAR_SCRIPT) },
      { path: "/vercel/sandbox/fix_gradle_repositories.py", content: Buffer.from(FABRIC_LOOM_REPOSITORY_FIX_SCRIPT) },
    ]);

    const inspectionCommand = await sandbox.runCommand("python3", ["/vercel/sandbox/inspect.py"]);
    const inspectionOutput = await inspectionCommand.stdout();
    const inspectionError = await inspectionCommand.stderr();
    logs += "$ Inspect project ZIP\n" + inspectionOutput + inspectionError + "\n";
    if (inspectionCommand.exitCode !== 0) {
      let message = "Project inspection failed.";
      try { message = JSON.parse(inspectionOutput).error || message; } catch {}
      return Response.json({ ok: false, message, logs: trimLog(logs) }, { status: 422 });
    }

    let inspection: { ok: boolean; kind: string; buildSystem?: string; gradleVersion?: string; gradleWrapper?: boolean; root?: string; projectType?: string; packs?: {path:string;name:string}[] };
    try { inspection = JSON.parse(inspectionOutput); }
    catch { return Response.json({ ok: false, message: "The worker returned an invalid project report.", logs: trimLog(logs) }, { status: 500 }); }

    let extension: "jar" | "mcpack" | "mcaddon";
    let artifactName = "";
    let artifactBuffer: Buffer | null = null;

    if (inspection.kind === "bedrock") {
      await sandbox.writeFiles([{ path: "/vercel/sandbox/inspection.json", content: Buffer.from(JSON.stringify(inspection)) }]);
      const packCommand = await sandbox.runCommand("python3", ["/vercel/sandbox/package_bedrock.py"]);
      const packOut = await packCommand.stdout();
      const packErr = await packCommand.stderr();
      logs += "$ Package Bedrock add-on\n" + packOut + packErr + "\n";
      if (packCommand.exitCode !== 0) {
        return Response.json({ ok: false, message: "Bedrock packaging failed.", logs: trimLog(logs) }, { status: 422 });
      }
      const details = JSON.parse(packOut);
      extension = details.extension;
      artifactName = details.name;
      const outputPath = extension === "mcpack" ? "result.mcpack" : "result.mcaddon";
      artifactBuffer = await sandbox.readFileToBuffer({ path: `/vercel/sandbox/${outputPath}` });
    } else if (inspection.kind === "java" && inspection.root && inspection.buildSystem) {
      logs += "$ Install isolated Java build tools\n";
      const install = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", "set -e; find /etc/apt -type f \\( -name '*.sources' -o -name '*.list' \\) -exec sed -i 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g; s|http://security.ubuntu.com|https://security.ubuntu.com|g; s|http://ports.ubuntu.com|https://ports.ubuntu.com|g' {} +; apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openjdk-21-jdk-headless maven curl unzip"],
        sudo: true,
      });
      const installOut = await install.stdout();
      const installErr = await install.stderr();
      logs += trimLog(installOut + installErr) + "\n";
      if (install.exitCode !== 0) {
        return Response.json({ ok: false, message: "Could not install the Java build toolchain in the isolated worker.", logs: trimLog(logs) }, { status: 503 });
      }

      if (inspection.buildSystem === "gradle") {
        logs += "$ Check Fabric Loom repository compatibility\\n";
        const compatibility = await sandbox.runCommand("python3", ["/vercel/sandbox/fix_gradle_repositories.py", inspection.root]);
        const compatibilityOut = await compatibility.stdout();
        const compatibilityErr = await compatibility.stderr();
        logs += compatibilityOut + compatibilityErr + "\\n";
        if (compatibility.exitCode !== 0) {
          return Response.json({ ok: false, message: "Could not prepare Gradle repositories for this project.", logs: trimLog(logs) }, { status: 422 });
        }
      }

      let build;
      if (inspection.buildSystem === "maven") {
        logs += "$ mvn -B -ntp -DskipTests package\n";
        build = await sandbox.runCommand({
          cmd: "mvn",
          args: ["-B", "-ntp", "-DskipTests", "package"],
          cwd: inspection.root,
        });
      } else if (inspection.gradleWrapper) {
        logs += "$ ./gradlew --no-daemon --no-scan build -x test\n";
        build = await sandbox.runCommand({
          cmd: "bash",
          args: ["./gradlew", "--no-daemon", "--no-scan", "build", "-x", "test"],
          cwd: inspection.root,
        });
      } else {
        const gradleVersion = /^\d+\.\d+(?:\.\d+)?$/.test(inspection.gradleVersion || "")
          ? inspection.gradleVersion!
          : "9.2.1";
        const gradleZip = "gradle-" + gradleVersion + "-bin.zip";
        const gradleUrl = "https://services.gradle.org/distributions/" + gradleZip;
        logs += "$ Bootstrap official Gradle " + gradleVersion + " (no wrapper found)\n";
        const bootstrap = await sandbox.runCommand({
          cmd: "bash",
          args: ["-lc", "set -euo pipefail\nZIP=/vercel/sandbox/" + gradleZip + "\nSUM=\"$ZIP.sha256\"\ncurl -fsSL \"" + gradleUrl + "\" -o \"$ZIP\"\ncurl -fsSL \"" + gradleUrl + ".sha256\" -o \"$SUM\"\nEXPECTED=\"$(awk '{print $1}' \"$SUM\")\"\nACTUAL=\"$(sha256sum \"$ZIP\" | awk '{print $1}')\"\ntest -n \"$EXPECTED\" && test \"$ACTUAL\" = \"$EXPECTED\"\nmkdir -p /vercel/sandbox/gradle-toolchain\nunzip -q \"$ZIP\" -d /vercel/sandbox/gradle-toolchain\nrm -f \"$ZIP\" \"$SUM\"\n/vercel/sandbox/gradle-toolchain/gradle-" + gradleVersion + "/bin/gradle --version"],
        });
        const bootstrapOut = await bootstrap.stdout();
        const bootstrapErr = await bootstrap.stderr();
        logs += trimLog(bootstrapOut + bootstrapErr) + "\n";
        if (bootstrap.exitCode !== 0) {
          return Response.json({ ok: false, message: "Could not bootstrap verified Gradle " + gradleVersion + " in the isolated worker.", logs: trimLog(logs) }, { status: 503 });
        }
        logs += "$ Gradle " + gradleVersion + " --no-daemon --no-scan build -x test\n";
        build = await sandbox.runCommand({
          cmd: "/vercel/sandbox/gradle-toolchain/gradle-" + gradleVersion + "/bin/gradle",
          args: ["--no-daemon", "--no-scan", "build", "-x", "test"],
          cwd: inspection.root,
        });
      }
      const buildOut = await build.stdout();
      const buildErr = await build.stderr();
      logs += trimLog(buildOut + buildErr) + "\n";
      if (build.exitCode !== 0) {
        return Response.json({ ok: false, message: "The Java build failed. Review the build log; unsupported dependency hosts are blocked by the worker network policy.", logs: trimLog(logs) }, { status: 422 });
      }

      const select = await sandbox.runCommand("python3", ["/vercel/sandbox/select_jar.py", inspection.root]);
      const selectOut = await select.stdout();
      const selectErr = await select.stderr();
      logs += "$ Select distributable JAR\n" + selectOut + selectErr + "\n";
      if (select.exitCode !== 0) {
        return Response.json({ ok: false, message: selectErr || "Build completed but no distributable JAR was found.", logs: trimLog(logs) }, { status: 422 });
      }
      const details = JSON.parse(selectOut);
      extension = "jar";
      artifactName = details.name;
      artifactBuffer = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/result.jar" });
    } else {
      return Response.json({ ok: false, message: "This project type is not supported by the current cloud build pipeline." }, { status: 422 });
    }

    if (!artifactBuffer || artifactBuffer.length < 1) {
      return Response.json({ ok: false, message: "The worker did not produce a downloadable artifact.", logs: trimLog(logs) }, { status: 500 });
    }

    const artifactPathname = `artifacts/${randomUUID()}.${extension}`;
    const contentType = extension === "jar" ? "application/java-archive" : "application/zip";
    await put(artifactPathname, artifactBuffer, {
      access: "private",
      addRandomSuffix: false,
      contentType,
    });

    return Response.json({
      ok: true,
      artifactPathname,
      artifactName,
      artifactBytes: artifactBuffer.length,
      message: "Build completed.",
      logs: trimLog(logs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloud build failed unexpectedly.";
    return Response.json({ ok: false, message: message.slice(0, 500), logs: trimLog(logs) }, { status: 500 });
  } finally {
    if (sandbox) {
      try { await sandbox.stop(); } catch {}
    }
    if (pathname) {
      try { await del(pathname); } catch {}
    }
  }
}
