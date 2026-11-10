
const ALLOWED_HOSTS = new Set([
  "interactive-examples.mdn.mozilla.net"
]);

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function validateURL(value) {
  let u;

  try {
    u = new URL(value);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (u.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are allowed.");
  }

  if (u.username || u.password) {
    throw new Error("URL credentials are not allowed.");
  }

  if (u.port && u.port !== "443") {
    throw new Error("Custom ports are not allowed.");
  }

  const host = u.hostname.toLowerCase();

  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error("This domain is not in the allowed-host list.");
  }

  return u;
}

async function safeFetch(value, headers = {}) {
  let current = validateURL(value);

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const response = await fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get("Location");

    if (!location || i === MAX_REDIRECTS) {
      throw new Error("Redirect limit reached.");
    }

    current = validateURL(
      new URL(location, current).toString()
    );
  }

  throw new Error("Unable to follow redirect.");
}

async function readLimited(response, limit) {
  if (!response.body) {
    throw new Error("Empty response.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > limit) {
        await reader.cancel();
        throw new Error("Response size limit exceeded.");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

function videoType(url, contentType = "") {
  const path = new URL(url).pathname.toLowerCase();

  if (path.endsWith(".mp4")) return "MP4";
  if (path.endsWith(".webm")) return "WebM";
  if (path.endsWith(".mov")) return "MOV";
  if (path.endsWith(".m3u8")) return "HLS";
  if (path.endsWith(".mpd")) return "DASH";

  if (contentType.startsWith("video/")) {
    return "Direct video";
  }

  return "Unknown";
}

function extractVideos(html, pageURL) {
  const results = new Map();

  function add(value, source) {
    if (!value) return;

    value = value.trim()
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");

    if (/^(data:|blob:|javascript:)/i.test(value)) {
      return;
    }

    try {
      const u = new URL(value, pageURL);

      if (u.protocol !== "https:") return;

      if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
        return;
      }

      results.set(u.href, {
        url: u.href,
        source,
        type: videoType(u.href)
      });
    } catch {
      // Invalid URL ignored.
    }
  }

  const tags = html.match(/<(?:video|source)\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const match = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);

    if (match) {
      add(match[1], "HTML video/source");
    }
  }

  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const property = (
      tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || []
    )[1];

    const content = (
      tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || []
    )[1];

    if (
      property &&
      /^(og:video|og:video:url|twitter:player:stream)$/i.test(property)
    ) {
      add(content, "Video metadata");
    }
  }

  return [...results.values()];
}

async function analyze(value) {
  const target = validateURL(value);

  // Direct video URL detection
  const response = await safeFetch(target.href, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,video/*,*/*"
  });

  if (!response.ok) {
    throw new Error("Website returned HTTP " + response.status);
  }

  const contentType = (
    response.headers.get("Content-Type") || ""
  ).toLowerCase();

  if (contentType.startsWith("video/")) {
    return json({
      success: true,
      message: "Direct video detected.",
      count: 1,
      videos: [{
        url: target.href,
        source: "Direct URL",
        type: videoType(target.href, contentType)
      }]
    });
  }

  if (!contentType.includes("text/html")) {
    throw new Error("URL did not return HTML or a direct video.");
  }

  const length = Number(
    response.headers.get("Content-Length") || 0
  );

  if (length > MAX_HTML_BYTES) {
    throw new Error("HTML page is too large.");
  }

  const bytes = await readLimited(response, MAX_HTML_BYTES);
  const html = new TextDecoder().decode(bytes);
  const videos = extractVideos(html, target.href);

  return json({
    success: true,
    message: videos.length
      ? "Video sources found."
      : "No supported video source found in static HTML.",
    count: videos.length,
    videos
  });
}

async function download(value) {
  const target = validateURL(value);

  const response = await safeFetch(target.href, {
    "User-Agent": "Mozilla/5.0"
  });

  if (!response.ok) {
    return json({
      error: "Video request failed with HTTP " + response.status
    }, 502);
  }

  const type = (
    response.headers.get("Content-Type") || ""
  ).toLowerCase();

  if (!type.startsWith("video/")) {
    return json({
      error: "Direct video file not detected."
    }, 415);
  }

  const length = Number(
    response.headers.get("Content-Length") || 0
  );

  if (length > MAX_BYTES) {
    return json({
      error: "Video exceeds 50 MB limit."
    }, 413);
  }

  const bytes = await readLimited(response, MAX_BYTES);

  return new Response(bytes, {
    headers: {
      ...CORS,
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "Content-Disposition": 'attachment; filename="video.mp4"',
      "Cache-Control": "no-store"
    }
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== "GET") {
      return json({ error: "GET requests only." }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        success: true,
        status: "online",
        app: "Universal Video Downloader",
        endpoints: ["/analyze?url=...", "/download?url=..."]
      });
    }

    if (url.pathname !== "/analyze" && url.pathname !== "/download") {
      return json({ error: "Endpoint not found." }, 404);
    }

    const target = url.searchParams.get("url");

    if (!target) {
      return json({ error: "Missing URL parameter." }, 400);
    }

    try {
      if (url.pathname === "/analyze") {
        return await analyze(target);
      }

      return await download(target);
    } catch (error) {
      return json({
        success: false,
        error: error.message
      }, 400);
    }
  }
};
