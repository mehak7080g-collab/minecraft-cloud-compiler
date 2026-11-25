import { get } from "@vercel/blob";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pathname = url.searchParams.get("pathname") || "";
  if (!/^artifacts\/[a-f0-9-]{30,40}\.(jar|mcpack|mcaddon)$/i.test(pathname)) {
    return new Response("Invalid artifact path.", { status: 400 });
  }

  try {
    const artifact = await get(pathname, { access: "private" });
    if (!artifact || artifact.statusCode !== 200) {
      return new Response("Artifact not found. It may have expired.", { status: 404 });
    }
    const extension = pathname.split(".").pop() || "zip";
    const contentType = extension === "jar" ? "application/java-archive" : "application/zip";
    return new Response(artifact.stream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="minecraft-build.${extension}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Artifact download failed.", { status: 500 });
  }
}
