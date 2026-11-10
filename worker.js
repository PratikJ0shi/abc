
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
  const u = new URL(value);

  if (u.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are allowed.");
  }

  if (u.username || u.password) {
    throw new Error("Credentials in URLs are not allowed.");
  }

  if (u.port && u.port !== "443") {
    throw new Error("Custom ports are not allowed.");
  }

  const host = u.hostname.toLowerCase();

  if (
    !ALLOWED_HOSTS.has(host) ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("This domain is not in the allowed-host list.");
  }

  return u;
}

async function safeFetch(url, headers = {}) {
  let current = validateURL(url);

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

function decodeHTML(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractVideos(html, pageURL) {
  const results = new Map();

  function add(value, source) {
    if (!value) return;

    value = decodeHTML(value.trim());

    if (
      value.startsWith("data:") ||
      value.startsWith("blob:") ||
      value.startsWith("javascript:")
    ) return;

    try {
      const u = new URL(value, pageURL);

      if (u.protocol !== "https:") return;

      results.set(u.href, {
        url: u.href,
        source,
        type: u.pathname.toLowerCase().endsWith(".m3u8")
          ? "HLS"
          : u.pathname.toLowerCase().endsWith(".mpd")
          ? "DASH"
          : u.pathname.toLowerCase().endsWith(".mp4")
          ? "MP4"
          : "Unknown"
      });
    } catch {}
  }

  // Video and source HTML elements
  const tags = html.match(/<(?:video|source)\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const match = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);

    if (match) add(match[1], "HTML video/source");
  }

  // Open Graph and Twitter video metadata
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

async function analyze(url) {
  const response = await safeFetch(url, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html"
  });

  if (!response.ok) {
    throw new Error("Website returned HTTP " + response.status);
  }

  const type = response.headers.get("Content-Type") || "";

  if (!type.toLowerCase().includes("text/html")) {
    throw new Error("URL did not return an HTML webpage.");
  }

  const length = Number(response.headers.get("Content-Length") || 0);

  if (length > MAX_HTML_BYTES) {
    throw new Error("HTML page is too large.");
  }

  const bytes = await readLimited(response, MAX_HTML_BYTES);
  const html = new TextDecoder().decode(bytes);

  const videos = extractVideos(html, url);

  return json({
    success: true,
    message: videos.length
      ? "Video sources found."
      : "No supported video source found in static HTML.",
    count: videos.length,
    videos
  });
}

async function download(url) {
  const response = await safeFetch(url, {
    "User-Agent": "Mozilla/5.0"
  });

  if (!response.ok) {
    return json({ error: "Video request failed." }, 502);
  }

  const type = response.headers.get("Content-Type") || "";

  if (!type.toLowerCase().startsWith("video/")) {
    return json({ error: "Direct video file not detected." }, 415);
  }

  const length = Number(response.headers.get("Content-Length") || 0);

  if (length > MAX_BYTES) {
    return json({ error: "Video exceeds 50 MB limit." }, 413);
  }

  if (!response.body) {
    return json({ error: "Empty video response." }, 502);
  }

  let total = 0;

  const limitedStream = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        total += chunk.byteLength;

        if (total > MAX_BYTES) {
          controller.error(new Error("Video size limit exceeded."));
          return;
        }

        controller.enqueue(chunk);
      }
    })
  );

  return new Response(limitedStream, {
    headers: {
      ...CORS,
      "Content-Type": type,
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

    try {
      if (url.pathname === "/") {
        return json({
          success: true,
          service: "Universal Video Downloader",
          endpoints: ["/analyze", "/download"]
        });
      }

      const target = url.searchParams.get("url");

      if (!target) {
        return json({ error: "Missing URL parameter." }, 400);
      }

      if (url.pathname === "/analyze") {
        return await analyze(target);
      }

      if (url.pathname === "/download") {
        return await download(target);
      }

      return json({ error: "Endpoint not found." }, 404);

    } catch (error) {
      return json({
        success: false,
        error: error.message
      }, 400);
    }
  }
};
