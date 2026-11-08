export async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function startLogin(): Promise<void> {
  const verifier = randomString(32);
  const state = randomString(16);
  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("oauth_state", state);
  const challenge = await digest(verifier);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: "medapp-spa",
    redirect_uri: "http://localhost:8080/auth/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  window.location.assign(
    `http://localhost:3000/auth/authorize?${query.toString()}`,
  );
}
