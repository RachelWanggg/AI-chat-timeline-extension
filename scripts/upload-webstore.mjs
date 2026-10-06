#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const publisherId =
  process.env.CHROME_WEB_STORE_PUBLISHER_ID ??
  "94ad5ad0-a335-4c8d-b90d-69617c288a46";
const extensionId =
  process.env.CHROME_WEB_STORE_EXTENSION_ID ??
  "ekjdciljnpfpolompiflnlglkooabpbg";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const credentialDirectory =
  process.env.AI_CHAT_TIMELINE_CWS_CONFIG_DIR ??
  join(homedir(), ".config", "ai-chat-timeline-extension");
const oauthClientPath = join(credentialDirectory, "oauth-client.json");
const refreshTokenPath = join(credentialDirectory, "refresh-token");

const runtimeFiles = [
  "manifest.json",
  "background.js",
  "content.js",
  "content",
  "panel",
  "icons",
];

function fail(message) {
  console.error(`[Web Store] ${message}`);
  process.exit(1);
}

function readCredentials() {
  if (!existsSync(oauthClientPath) || !existsSync(refreshTokenPath)) {
    fail(
      `Missing OAuth credentials in ${credentialDirectory}. Expected oauth-client.json and refresh-token.`,
    );
  }

  // 凭据不应被同一台机器上的其他用户读取。
  for (const path of [oauthClientPath, refreshTokenPath]) {
    if ((statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
    }
  }

  const oauthClient = JSON.parse(readFileSync(oauthClientPath, "utf8")).web;
  const refreshToken = readFileSync(refreshTokenPath, "utf8").trim();

  if (!oauthClient?.client_id || !oauthClient?.client_secret || !refreshToken) {
    fail("OAuth credential files are incomplete.");
  }

  return {
    clientId: oauthClient.client_id,
    clientSecret: oauthClient.client_secret,
    refreshToken,
  };
}

async function parseJsonResponse(response, action) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(`${action} returned a non-JSON response (${response.status}).`);
  }

  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.error_description ?? "Unknown error";
    fail(`${action} failed (${response.status}): ${message}`);
  }

  return payload;
}

async function getAccessToken() {
  const credentials = readCredentials();
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await parseJsonResponse(response, "OAuth token refresh");

  if (!payload.access_token) {
    fail("OAuth token refresh did not return an access token.");
  }

  return payload.access_token;
}

function buildArchive() {
  const manifest = JSON.parse(
    readFileSync(join(projectDirectory, "manifest.json"), "utf8"),
  );
  const archivePath = join(
    projectDirectory,
    `timeline-extension-v${manifest.version}.zip`,
  );

  if (existsSync(archivePath)) {
    rmSync(archivePath);
  }

  execFileSync("zip", ["-qr", archivePath, ...runtimeFiles], {
    cwd: projectDirectory,
    stdio: "inherit",
  });

  return { archivePath, version: manifest.version };
}

async function fetchStatus(accessToken) {
  const url =
    `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}` +
    `/items/${extensionId}:fetchStatus`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return parseJsonResponse(response, "Status request");
}

async function uploadArchive(accessToken, archivePath) {
  const url =
    `https://chromewebstore.googleapis.com/upload/v2/publishers/${publisherId}` +
    `/items/${extensionId}:upload`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/zip",
    },
    body: readFileSync(archivePath),
  });
  return parseJsonResponse(response, "Package upload");
}

async function main() {
  const statusOnly = process.argv.includes("--status");
  const accessToken = await getAccessToken();

  if (statusOnly) {
    const status = await fetchStatus(accessToken);
    const published = status.publishedItemRevisionStatus;
    const channel = published?.distributionChannels?.[0];
    console.log(
      `[Web Store] ${published?.state ?? "UNKNOWN"}; published version ${channel?.crxVersion ?? "unknown"}.`,
    );
    return;
  }

  const { archivePath, version } = buildArchive();
  console.log(`[Web Store] Built ${archivePath}`);

  const upload = await uploadArchive(accessToken, archivePath);
  console.log(
    `[Web Store] Upload ${upload.uploadState ?? "UNKNOWN"} for version ${version}.`,
  );
  console.log("[Web Store] Draft uploaded only; review/publishing was not requested.");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
