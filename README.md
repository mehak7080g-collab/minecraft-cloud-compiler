# Minecraft Cloud Compiler

A free-by-design early-access tool for inspecting Minecraft project ZIPs and building a limited set of Java and Bedrock projects in disposable Vercel Sandbox workers.

## Current build paths

- **Bedrock:** validates pack manifests and packages one pack as `.mcpack`, or multiple detected packs as `.mcaddon`.
- **Java / Maven:** detects a single Maven project and attempts `mvn -B -ntp -DskipTests package`.
- **Java / Gradle:** requires a Gradle wrapper and an official HTTPS Gradle distribution URL, then attempts `./gradlew --no-daemon --no-scan build -x test`.
- **JAR output:** selects a distributable JAR from Maven `target/` or Gradle `build/libs/`.

The compiler does not claim to support every Minecraft loader or arbitrary project layout. Projects with conflicting build systems, multiple build roots, missing wrappers, unknown hosts, or unsupported dependencies are rejected rather than guessed.

## Limits

- ZIP upload: 50 MB
- Extracted project: 250 MB maximum
- Files: 5,000 maximum
- Per-file extraction: 64 MB maximum
- Java worker: 1 vCPU, 240-second sandbox timeout
- JAR output: 100 MB maximum
- Artifact cleanup: best-effort after 24 hours

Free Vercel Hobby storage and compute quotas are finite; unlimited builds or storage are not promised.

## Security boundaries

- ZIP paths, symbolic links, compression ratios, and extracted sizes are checked.
- Uploaded environment files and common credential files are not copied into build workspaces.
- User builds run in disposable Firecracker workers with no repository or application secrets.
- Worker network access is restricted to known package and Minecraft dependency hosts.
- Maven and Gradle tests are skipped in this first version; build scripts and third-party dependencies are still untrusted code.
- Anonymous public access currently has no durable per-user quota or abuse-control layer. Treat this as an early-access test, not a hardened public build service.

## Local development

Requires Node.js 20.9+.

```bash
npm install
npm run dev
```

## Roadmap

- [x] ZIP inspection and evidence-based platform detection
- [x] Private temporary ZIP uploads
- [x] Disposable isolated worker integration
- [x] Bedrock pack packaging
- [x] Initial Maven / Gradle JAR pipeline
- [ ] End-to-end tests for supported Java projects
- [ ] Durable user quotas and rate limiting
- [ ] Better loader/version-specific dependency profiles
- [ ] Automatic cleanup monitoring and operational alerts
- [ ] Git-linked Vercel auto-deploy
