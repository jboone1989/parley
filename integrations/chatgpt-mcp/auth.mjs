import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const secretFile = join(here, ".bridge-secret");
if (!existsSync(secretFile)) {
  try { writeFileSync(secretFile, randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 }); }
  catch (err) { if (err.code !== "EEXIST") throw err; }
}
chmodSync(secretFile, 0o600);
const secret = Buffer.from(readFileSync(secretFile, "utf8").trim());
const cloudflareTeam = (process.env.PARLEY_CF_ACCESS_TEAM || "").replace(/\/$/, "");
const cloudflareAud = process.env.PARLEY_CF_ACCESS_AUD || "";
const issuer = (process.env.PARLEY_OAUTH_ISSUER || "").replace(/\/$/, "");
const audience = process.env.PARLEY_OAUTH_AUDIENCE || "";
const publicUrl = (process.env.PARLEY_MCP_PUBLIC_URL || "").replace(/\/$/, "");
const cloudflare = !!(cloudflareTeam && cloudflareAud);
if (!!cloudflareTeam !== !!cloudflareAud) throw Error("Configure both Cloudflare Access team and AUD.");
if (cloudflare && issuer) throw Error("Use either Cloudflare Access or external OAuth, not both.");
if (!!issuer !== !!audience) throw Error("Configure both OAuth issuer and audience.");
if (issuer && (!issuer.startsWith("https://") || !publicUrl.startsWith("https://"))) {
  throw Error("External OAuth requires HTTPS issuer and public URL.");
}
let jwks;
export const oauthEnabled = () => cloudflare || !!issuer;
export const resourceMetadata = () => issuer ? {
  resource: publicUrl, authorization_servers: [issuer], scopes_supported: ["parley:access"]
} : null;
export function authenticationChallenge() {
  if (issuer) return 'Bearer resource_metadata="' + publicUrl + '/.well-known/oauth-protected-resource", scope="parley:access"';
  if (cloudflare) return 'Bearer realm="Cloudflare Access"';
  return 'Bearer realm="Parley private MCP"';
}
export async function verifyRequest(req) {
  if (cloudflare) {
    const jwt = req.headers["cf-access-jwt-assertion"];
    if (!jwt) return false;
    try {
      const { createRemoteJWKSet, jwtVerify } = await import("jose");
      if (!jwks) jwks = createRemoteJWKSet(new URL(cloudflareTeam + "/cdn-cgi/access/certs"));
      await jwtVerify(String(jwt), jwks, { issuer: cloudflareTeam, audience: cloudflareAud });
      return true;
    } catch { return false; }
  }
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return false;
  if (!issuer) {
    const received = Buffer.from(bearer);
    return received.length === secret.length && timingSafeEqual(received, secret);
  }
  try {
    const { createRemoteJWKSet, jwtVerify } = await import("jose");
    if (!jwks) jwks = createRemoteJWKSet(new URL(process.env.PARLEY_OAUTH_JWKS_URL || issuer + "/.well-known/jwks.json"));
    const { payload } = await jwtVerify(bearer, jwks, { issuer, audience });
    return String(payload.scope || "").split(" ").includes("parley:access");
  } catch { return false; }
}
