import crypto from "node:crypto";
import fetch from "node-fetch";

const OIDC_ISSUER = process.env.OIDC_ISSUER || "http://localhost:8000";
const OIDC_CLIENT_ID =
	process.env.OIDC_CLIENT_ID || "63ac8f3b-cb26-42fb-9320-a19690047a40";
const OIDC_CLIENT_SECRET =
	process.env.OIDC_CLIENT_SECRET || "91ddeced-16f6-46a2-b75e-ddd0cda1aa6e";
const REDIRECT_URI =
	process.env.REDIRECT_URI || "http://localhost:3000/auth/callback";

/**
 * Generate authorization URL for login (Authorization Code Flow with PKCE)
 */
export function getAuthorizationUrl() {
	const state = crypto.randomBytes(16).toString("hex");
	const nonce = crypto.randomBytes(16).toString("hex");
	const codeVerifier = crypto.randomBytes(32).toString("hex");
	const codeChallenge = crypto
		.createHash("sha256")
		.update(codeVerifier)
		.digest("base64url");

	const authorizationUrl = new URL(`${OIDC_ISSUER}/api/auth/signin`);
	authorizationUrl.searchParams.append("client_id", OIDC_CLIENT_ID);
	authorizationUrl.searchParams.append("redirect_uri", REDIRECT_URI);
	authorizationUrl.searchParams.append("response_type", "code");
	authorizationUrl.searchParams.append("scope", "openid profile email");
	authorizationUrl.searchParams.append("state", state);
	authorizationUrl.searchParams.append("nonce", nonce);
	authorizationUrl.searchParams.append("code_challenge", codeChallenge);
	authorizationUrl.searchParams.append("code_challenge_method", "S256");

	return {
		url: authorizationUrl.toString(),
		state,
		nonce,
		codeVerifier,
	};
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(code, codeVerifier) {
	const tokenUrl = `${OIDC_ISSUER}/api/auth/token`;

	const params = new URLSearchParams();
	params.append("grant_type", "authorization_code");
	params.append("code", code);
	params.append("client_id", OIDC_CLIENT_ID);
	params.append("client_secret", OIDC_CLIENT_SECRET);
	params.append("redirect_uri", REDIRECT_URI);
	params.append("code_verifier", codeVerifier);

	try {
		const response = await fetch(tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params.toString(),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Token exchange failed: ${response.status} ${error}`);
		}

		const tokenData = await response.json();
		console.debug("[auth-service] raw token response:", tokenData);

		// Normalize token response formats (handle nested `data` or different key names)
		const maybeData =
			tokenData && typeof tokenData === "object"
				? tokenData.data || tokenData
				: {};
		const accessToken =
			maybeData.access_token ||
			maybeData.accessToken ||
			tokenData.access_token ||
			tokenData.accessToken;
		const idToken =
			maybeData.id_token ||
			maybeData.idToken ||
			tokenData.id_token ||
			tokenData.idToken;
		const refreshToken =
			maybeData.refresh_token ||
			maybeData.refreshToken ||
			tokenData.refresh_token ||
			tokenData.refreshToken;
		const expiresIn =
			maybeData.expires_in ||
			maybeData.expiresIn ||
			tokenData.expires_in ||
			tokenData.expiresIn ||
			3600;

		return {
			accessToken,
			idToken,
			refreshToken,
			expiresIn,
		};
	} catch (error) {
		console.error("Token exchange error:", error);
		throw error;
	}
}

/**
 * Fetch user info using access token
 */
export async function getUserInfo(accessToken) {
	const userInfoUrl = `${OIDC_ISSUER}/api/auth/userinfo`;

	try {
		const response = await fetch(userInfoUrl, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		const text = await response.text();
		const authHeader = `Bearer ${accessToken}`;
		console.debug("[auth-service] Authorization header sent:", authHeader);

		if (!response.ok) {
			console.error(
				"[auth-service] userinfo error response:",
				response.status,
				text,
			);
			throw new Error(`Failed to fetch user info: ${response.status} ${text}`);
		}

		let userInfo;
		try {
			userInfo = JSON.parse(text);
		} catch (parseErr) {
			console.error("[auth-service] userinfo parse error, raw body:", text);
			throw new Error("Failed to parse user info response");
		}

		console.debug("[auth-service] userinfo:", userInfo);
		return userInfo;
	} catch (error) {
		console.error("User info fetch error:", error);
		throw error;
	}
}

/**
 * Validate and refresh token if needed
 */
export async function validateAndRefreshToken(refreshToken) {
	const tokenUrl = `${OIDC_ISSUER}/api/auth/token`;

	const params = new URLSearchParams();
	params.append("grant_type", "refresh_token");
	params.append("refresh_token", refreshToken);
	params.append("client_id", OIDC_CLIENT_ID);
	params.append("client_secret", OIDC_CLIENT_SECRET);

	try {
		const response = await fetch(tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params.toString(),
		});

		if (!response.ok) {
			throw new Error(`Token refresh failed: ${response.status}`);
		}

		const tokenData = await response.json();
		return {
			accessToken: tokenData.access_token,
			idToken: tokenData.id_token,
			refreshToken: tokenData.refresh_token || refreshToken,
			expiresIn: tokenData.expires_in || 3600,
		};
	} catch (error) {
		console.error("Token refresh error:", error);
		throw error;
	}
}
