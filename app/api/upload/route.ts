import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("incoming/") || !pathname.endsWith(".zip") || pathname.includes("..")) {
          throw new Error("Only ZIP project uploads are allowed.");
        }
        return {
          allowedContentTypes: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
          maximumSizeInBytes: 50 * 1024 * 1024,
          validUntil: Date.now() + 15 * 60 * 1000,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ purpose: "minecraft-project-build" }),
        };
      },
    });
    return Response.json(response);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Upload authorization failed." },
      { status: 400 },
    );
  }
}
