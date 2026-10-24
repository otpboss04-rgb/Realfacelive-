const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
const REPLICATE_VERSION = "278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });
}
function b64(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(out);
}
function dataUrl(file, bytes) {
  return `data:${file.type};base64,${b64(bytes)}`;
}
function b64url(bytes) {
  return b64(new Uint8Array(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 180000, hash: "SHA-256" }, key, 256);
  return b64url(bits);
}
async function makeToken(user, secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ sub:user.id, email:user.email, exp:Date.now()+7*24*60*60*1000 })));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return payload + "." + b64url(sig);
}
function fromB64url(value) {
  let s = value.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function readToken(token, secret) {
  try {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, fromB64url(signature), new TextEncoder().encode(payload));
    if (!valid) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
async function getUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = await readToken(token, env.SESSION_SECRET);
  if (!session) return null;
  const raw = await env.AUTH_KV.get("user:" + session.email);
  return raw ? JSON.parse(raw) : null;
}
async function faceSwap(request, env) {
  if (!env.REPLICATE_API_TOKEN) return json({ error:"The face-swap engine is not configured yet. Add REPLICATE_API_TOKEN to Worker secrets." }, 503);
  const user = await getUser(request, env);
  if (!user) return json({ error:"Please log in again before using the face-swap tool." }, 401);
  let form;
  try { form = await request.formData(); } catch { return json({ error:"Please select both images and try again." }, 400); }
  const target = form.get("targetImage");
  const source = form.get("sourceImage");
  if (!(target instanceof File) || !(source instanceof File)) return json({ error:"Choose the target photo and the source face photo." }, 400);
  for (const f of [target, source]) {
    if (!["image/jpeg","image/png","image/webp"].includes(f.type)) return json({ error:"Use JPG, PNG or WEBP images." }, 400);
    if (f.size > MAX_IMAGE_BYTES) return json({ error:"Each image must be 4 MB or smaller for this first test." }, 413);
  }
  const [targetBytes, sourceBytes] = await Promise.all([target.arrayBuffer(), source.arrayBuffer()]);
  const payload = {
    version: REPLICATE_VERSION,
    input: {
      input_image: dataUrl(target, new Uint8Array(targetBytes)),
      swap_image: dataUrl(source, new Uint8Array(sourceBytes))
    }
  };
  let response, result;
  try {
    response = await fetch("https://api.replicate.com/v1/predictions", {
      method:"POST",
      headers:{ "Authorization":"Bearer " + env.REPLICATE_API_TOKEN, "Content-Type":"application/json", "Prefer":"wait=1" },
      body:JSON.stringify(payload)
    });
    result = await response.json();
  } catch {
    return json({ error:"Could not reach the AI engine. Check the Worker secret and try again." }, 502);
  }
  if (!response.ok) return json({ error: result.detail || result.title || "The AI engine rejected this request. Check the Replicate account and model access." }, 502);
  return json({ ok:true, predictionId:result.id, status:result.status, output:result.output || null, pollUrl:result.urls?.get || null });
}
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers:CORS });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!env.AUTH_KV || !env.SESSION_SECRET) return json({ error:"Account setup is incomplete. Configure AUTH_KV and SESSION_SECRET." }, 500);
      if (url.pathname === "/api/faceswap") {
        if (request.method !== "POST") return json({ error:"Use POST for this endpoint." }, 405);
        return faceSwap(request, env);
      }
      if (url.pathname === "/api/face-status") {
        if (request.method !== "POST") return json({ error:"Use POST for this endpoint." }, 405);
        if (!env.REPLICATE_API_TOKEN) return json({ error:"AI engine is not configured." }, 503);
        const user = await getUser(request, env);
        if (!user) return json({ error:"Please log in again." }, 401);
        let body; try { body = await request.json(); } catch { return json({ error:"Invalid request." }, 400); }
        const id = String(body.id || "");
        if (!/^[a-zA-Z0-9-]+$/.test(id)) return json({ error:"Invalid prediction ID." }, 400);
        const r = await fetch("https://api.replicate.com/v1/predictions/" + id, { headers:{ "Authorization":"Bearer " + env.REPLICATE_API_TOKEN } });
        const d = await r.json();
        if (!r.ok) return json({ error:d.detail || "Could not check the AI job." }, 502);
        return json({ ok:true, id:d.id, status:d.status, output:d.output || null, error:d.error || null });
      }
      if (request.method !== "POST") return json({ error:"Use POST for this endpoint." }, 405);
      let body; try { body = await request.json(); } catch { return json({ error:"Invalid JSON." }, 400); }
      if (url.pathname === "/api/register") {
        const name = String(body.name || "").trim().slice(0,80);
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        if (name.length < 2) return json({ error:"Enter your name." },400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error:"Enter a valid email." },400);
        if (password.length < 10) return json({ error:"Password must be at least 10 characters." },400);
        const key = "user:" + email;
        if (await env.AUTH_KV.get(key)) return json({ error:"An account with this email already exists. Please log in." },409);
        const salt = crypto.randomUUID();
        const user = { id:crypto.randomUUID(), name, email, salt, passwordHash:await hashPassword(password,salt), createdAt:new Date().toISOString() };
        await env.AUTH_KV.put(key,JSON.stringify(user));
        return json({ ok:true, token:await makeToken(user,env.SESSION_SECRET), user:{name,email} },201);
      }
      if (url.pathname === "/api/login") {
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const raw = await env.AUTH_KV.get("user:" + email);
        if (!raw) return json({ error:"Email or password is incorrect." },401);
        const user = JSON.parse(raw);
        if (await hashPassword(password,user.salt) !== user.passwordHash) return json({ error:"Email or password is incorrect." },401);
        return json({ ok:true, token:await makeToken(user,env.SESSION_SECRET), user:{name:user.name,email:user.email} });
      }
      if (url.pathname === "/api/me") {
        const user = await getUser(request,env);
        return user ? json({ok:true,user:{name:user.name,email:user.email}}) : json({error:"Please log in again."},401);
      }
      return json({error:"Unknown API route."},404);
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Static assets are not configured.",{status:500});
  }
};
