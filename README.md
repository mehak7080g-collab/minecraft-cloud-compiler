# Minecraft Cloud Compiler

A free-by-design Minecraft project analyzer and future cloud build service for Java Edition and Bedrock projects.

## Current milestone

- Next.js dashboard and ZIP upload UI.
- Static project structure analysis.
- Initial detection for Paper, Bukkit/Spigot, Fabric, Forge, NeoForge and Bedrock add-ons.
- Maven and Gradle detection.
- Best-effort Minecraft and Java version extraction.
- Uploaded build scripts are never executed during analysis.
- Cloud compilation is not enabled yet.

## Local development

Requires Node.js 20.9+.

```bash
npm install
npm run dev
```

## Safety principles

- Structure analysis is mandatory before selecting a build pipeline.
- Unknown or conflicting platform evidence must be reported honestly.
- Uploaded scripts must not run on a shared runner with repository secrets.
- Real builds require isolated, disposable workers with bounded resources.
- Temporary uploads and artifacts must expire automatically.
- Free-tier quotas must be enforced; paid overages must not be enabled by default.

## Roadmap

- [ ] Detection fixtures and automated tests
- [ ] Secure temporary upload storage
- [ ] Job queue and isolated build workers
- [ ] Java plugin and mod build pipelines
- [ ] Bedrock pack validation and packaging
- [ ] Build logs, downloads and expiry

GitHub Actions and Vercel free quotas are finite. Free does not mean unlimited compute, storage or concurrency.
