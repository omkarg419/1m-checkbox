import { redis } from "./redis-connection.js";

const SESSION_PREFIX = "session:";
const SESSION_EXPIRY = 24 * 60 * 60; // 24 hours

function normalizeUserData(userData = {}) {
	const source = userData.data || userData.user || userData.profile || userData;

	return {
		userId:
			source.sub ||
			source.id ||
			source.userId ||
			source.uid ||
			source.email ||
			null,
		email: source.email || source.preferred_username || null,
		name:
			source.name ||
			source.display_name ||
			source.username ||
			source.preferred_username ||
			source.email ||
			null,
		picture: source.picture || source.avatar || null,
		accessToken: source.accessToken || source.access_token || null,
		refreshToken: source.refreshToken || source.refresh_token || null,
		expiresIn: source.expiresIn || source.expires_in || 3600,
	};
}

/**
 * Create or update user session in Redis
 */
export async function createSession(sessionId, userData) {
	const sessionKey = `${SESSION_PREFIX}${sessionId}`;
	const normalizedUserData = normalizeUserData(userData);
	const sessionData = {
		userId: normalizedUserData.userId,
		email: normalizedUserData.email,
		name: normalizedUserData.name,
		picture: normalizedUserData.picture,
		accessToken: normalizedUserData.accessToken,
		refreshToken: normalizedUserData.refreshToken,
		expiresAt: Date.now() + normalizedUserData.expiresIn * 1000,
		createdAt: Date.now(),
	};

	await redis.setex(sessionKey, SESSION_EXPIRY, JSON.stringify(sessionData));
	return sessionData;
}

/**
 * Retrieve session data from Redis
 */
export async function getSession(sessionId) {
	const sessionKey = `${SESSION_PREFIX}${sessionId}`;
	const sessionData = await redis.get(sessionKey);
	return sessionData ? JSON.parse(sessionData) : null;
}

/**
 * Check if session is still valid
 */
export async function isSessionValid(sessionId) {
	const session = await getSession(sessionId);
	if (!session) return false;

	// Check if token has expired
	if (session.expiresAt < Date.now()) {
		await destroySession(sessionId);
		return false;
	}

	return true;
}

/**
 * Destroy session (logout)
 */
export async function destroySession(sessionId) {
	const sessionKey = `${SESSION_PREFIX}${sessionId}`;
	await redis.del(sessionKey);
}

/**
 * Update session token on refresh
 */
export async function updateSessionToken(sessionId, tokenData) {
	const session = await getSession(sessionId);
	if (!session) return null;

	session.accessToken = tokenData.accessToken;
	session.refreshToken = tokenData.refreshToken || session.refreshToken;
	session.expiresAt = Date.now() + tokenData.expiresIn * 1000;

	const sessionKey = `${SESSION_PREFIX}${sessionId}`;
	await redis.setex(sessionKey, SESSION_EXPIRY, JSON.stringify(session));

	return session;
}

/**
 * Get all active sessions (admin/debugging)
 */
export async function getAllActiveSessions() {
	const keys = await redis.keys(`${SESSION_PREFIX}*`);
	const sessions = [];

	for (const key of keys) {
		const data = await redis.get(key);
		if (data) {
			sessions.push({
				sessionId: key.replace(SESSION_PREFIX, ""),
				data: JSON.parse(data),
			});
		}
	}

	return sessions;
}
