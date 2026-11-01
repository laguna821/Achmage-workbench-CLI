const url = new URL(process.argv[2]);
if (url.origin !== "https://accounts.google.com" || url.searchParams.get("client_id") !== "fixture.apps.googleusercontent.com" || url.searchParams.get("code_challenge_method") !== "S256") throw new Error("Unexpected fixture sign-in");
const callback = new URL(url.searchParams.get("redirect_uri"));
if (callback.hostname !== "127.0.0.1") throw new Error("Fixture callback must be loopback");
callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", url.searchParams.get("state"));
const result = await fetch(callback); if (!result.ok) throw new Error("Fixture callback was rejected");
